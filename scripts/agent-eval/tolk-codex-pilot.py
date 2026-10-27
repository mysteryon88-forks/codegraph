#!/usr/bin/env python3
"""Linux-only, subscription-authenticated W1-W3 pilot. No automatic retries or API keys."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import tempfile
import time

PIN = "187e0589f437fe398e3385f4a434e9755d1b4d87"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def command(args, env, cwd=None, timeout=180):
    return subprocess.run(args, env=env, cwd=cwd, text=True, capture_output=True,
                          timeout=timeout, check=True).stdout


def clean_env(home, auth_home=None):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("CODEX_", "OPENAI_", "ANTHROPIC_", "CODEGRAPH_"))}
    env.update(HOME=str(home), CODEX_HOME=str(auth_home or Path.home() / ".codex"),
               DO_NOT_TRACK="1", CODEGRAPH_TELEMETRY="0", CODEGRAPH_NO_UPDATE_CHECK="1",
               CODEGRAPH_WASM_RELAUNCHED="1", CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS="600000",
               CODEGRAPH_MCP_TOOLS="explore,node")
    return env


def config(root, bundle, with_graph, auth_home):
    values = ['model_reasoning_effort="high"', 'model_provider="openai"',
              'forced_login_method="chatgpt"', 'approval_policy="never"',
              'project_doc_max_bytes=0', 'hide_agent_reasoning=true',
              'web_search="disabled"', 'history.persistence="none"']
    for feature in ("apps", "plugins", "multi_agent", "memories", "hooks", "browser_use",
                    "browser_use_external", "computer_use", "image_generation",
                    "in_app_browser", "workspace_dependencies", "shell_snapshot"):
        values.append(f"features.{feature}=false")
    skills = auth_home / "skills"
    disabled = [f'{{path={json.dumps(str(p))},enabled=false}}' for p in skills.rglob("SKILL.md")]
    if disabled:
        values.append("skills.config=[" + ",".join(disabled) + "]")
    if with_graph:
        values.append('mcp_servers.codegraph={command=' + json.dumps(str(bundle / "bin/codegraph"))
                      + ',args=["serve","--mcp","--path",' + json.dumps(str(root))
                      + '],enabled=true,required=true,startup_timeout_sec=20}')
    return [a for value in values for a in ("-c", value)]


def stop_group(proc):
    if proc.poll() is None:
        os.killpg(proc.pid, signal.SIGTERM)
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(5)


def on_terminate(_signum, _frame):
    raise KeyboardInterrupt("Controller received SIGTERM")


def failure_status(exc):
    return "interrupted" if isinstance(exc, KeyboardInterrupt) else "infrastructure-error"


def rpc(proc, request, timeout=15):
    proc.stdin.write(json.dumps(request) + "\n")
    proc.stdin.flush()
    deadline = time.monotonic() + timeout
    with selectors.DefaultSelector() as selector:
        selector.register(proc.stdout, selectors.EVENT_READ)
        while time.monotonic() < deadline:
            if not selector.select(max(0, deadline - time.monotonic())):
                break
            line = proc.stdout.readline()
            if not line:
                raise RuntimeError("MCP process exited before response")
            value = json.loads(line)
            if value.get("id") == request["id"]:
                if "error" in value:
                    raise RuntimeError(str(value["error"]))
                return value["result"]
    raise TimeoutError("MCP readiness timeout")


def prewarm(root, bundle, env, out):
    with (out / "prewarm.stderr").open("w") as err:
        proc = None
        try:
            proc = subprocess.Popen([str(bundle / "bin/codegraph"), "serve", "--mcp", "--path", str(root)],
                                    env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err,
                                    text=True, start_new_session=True)
            save(out / "prewarm-pid.json", {"pid": proc.pid})
            init = rpc(proc, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2024-11-05", "capabilities": {},
                "clientInfo": {"name": "codex-pilot-preflight", "version": "1"}}})
            proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
            proc.stdin.flush()
            tools = rpc(proc, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
            names = [tool["name"] for tool in tools["tools"]]
            assert "codegraph_explore" in names and "codegraph_node" in names, names
            # The proxy answers initialize/tools locally before its daemon binds.
            deadline = time.monotonic() + 15
            lock = None
            while time.monotonic() < deadline:
                try:
                    candidate = json.loads((root / ".codegraph/daemon.pid").read_text())
                    if Path(candidate["socketPath"]).exists():
                        lock = candidate
                        break
                except FileNotFoundError:
                    pass
                time.sleep(0.1)
            if lock is None:
                raise TimeoutError("Daemon socket not ready after MCP handshake")
            save(out / "readiness.json", {"pid": proc.pid, "daemon": lock, "tools": names,
                                          "serverInfo": init.get("serverInfo")})
        finally:
            if proc is not None:
                try:
                    proc.stdin.close()
                except BrokenPipeError:
                    pass
                try:
                    proc.wait(10)
                except subprocess.TimeoutExpired:
                    stop_group(proc)


def summarize(events):
    items, usage, errors = {}, [], []
    for event in events:
        if event.get("type") == "item.completed":
            item = event["item"]
            items[item["id"]] = item
        if event.get("type") == "turn.completed":
            usage.append(event.get("usage", {}))
        if event.get("type") in ("error", "turn.failed"):
            errors.append(event)
    tools = [i for i in items.values() if i["type"] in ("command_execution", "mcp_tool_call", "web_search", "file_change")]
    commands = [i.get("command", "") for i in tools if i["type"] == "command_execution"]
    return {"tool_count": len(tools), "commands": commands, "tools": tools, "usage": usage, "errors": errors}


def completed_answer(result, text):
    return bool(result.get("usage")) and not result.get("errors") and bool(text.strip())


def self_test():
    sample = [{"type": "item.completed", "item": {"id": "a", "type": "command_execution", "command": "rg x"}},
              {"type": "item.completed", "item": {"id": "a", "type": "command_execution", "command": "rg x"}},
              {"type": "turn.completed", "usage": {"input_tokens": 12}}]
    result = summarize(sample)
    assert result["tool_count"] == 1 and result["usage"][0]["input_tokens"] == 12
    previous = os.environ.get("OPENAI_API_KEY")
    try:
        os.environ["OPENAI_API_KEY"] = "test-sentinel"
        assert "OPENAI_API_KEY" not in clean_env(Path("/tmp"))
    finally:
        if previous is None:
            os.environ.pop("OPENAI_API_KEY", None)
        else:
            os.environ["OPENAI_API_KEY"] = previous
    assert completed_answer({"usage": [{"input_tokens": 12}], "errors": []}, "answer")
    assert not completed_answer({"usage": [], "errors": []}, "answer")
    assert not completed_answer({"usage": [{}], "errors": ["failed"]}, "answer")
    assert not completed_answer({"usage": [{}], "errors": []}, "  ")
    previous_handler = signal.signal(signal.SIGTERM, on_terminate)
    interrupted = False
    try:
        if os.name == "posix":
            os.kill(os.getpid(), signal.SIGTERM)
        else:
            on_terminate(signal.SIGTERM, None)
    except KeyboardInterrupt as exc:
        interrupted = True
        assert failure_status(exc) == "interrupted"
    finally:
        signal.signal(signal.SIGTERM, previous_handler)
    assert interrupted and failure_status(RuntimeError()) == "infrastructure-error"
    assert len([(t, r, a) for t in ("W1", "W2", "W3")
                for r, arms in ((1, ("A", "B")), (2, ("B", "A"))) for a in arms]) == 12
    print("self-test passed")


def run(args):
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    home = out / "empty-home"
    home.mkdir(exist_ok=True)
    env = clean_env(home, args.auth_home)
    auth = json.loads((Path(env["CODEX_HOME"]) / "auth.json").read_text())
    assert auth.get("auth_mode") == "chatgpt", "ChatGPT subscription login required"
    del auth
    protocol = args.protocol.read_text()
    common = re.search(r"> (Investigate only.*?)\n", protocol)[1]
    prompt = re.search(r"\*\*" + args.task + r" —[^\n]*\n> (.*?)\n", protocol)[1]
    task_prompt = common + "\n\n" + prompt
    order = ((3, ("A", "B")),) if args.additional_w1_pair else ((1, ("A", "B")), (2, ("B", "A")))
    for repeat, arms in order:
        for arm in arms:
            label = f"{args.task}-r{repeat}-{arm}"
            evidence = out / label
            if evidence.exists() and args.resume:
                prior = json.loads((evidence / "result.json").read_text())
                assert prior["status"] in ("completed", "failed", "timeout", "infrastructure-error", "interrupted"), prior
                print(f"RETAIN {label} {prior['status']} (no retry)", flush=True)
                continue
            evidence.mkdir()  # Refuse overwriting or retrying an existing session.
            root = Path(tempfile.mkdtemp(prefix="cgpilot-")) / "repo"
            start = time.monotonic()
            result = {"label": label, "root": str(root), "status": "preparation"}
            save(evidence / "result.json", result)
            try:
                command(["git", "clone", "--quiet", "--no-hardlinks", str(args.corpus), str(root)], env)
                command(["git", "checkout", "--quiet", "--detach", PIN], env, root)
                tracked = command(["git", "ls-files", "-z"], env, root).split("\0")
                digest = sha(b"".join(p.encode() + b"\0" + (root / p).read_bytes() for p in tracked if p))
                assert command(["git", "status", "--porcelain", "--untracked-files=no"], env, root) == ""
            except (Exception, KeyboardInterrupt) as exc:
                result.update(status=failure_status(exc), exception=f"{type(exc).__name__}: {exc}")
                save(evidence / "result.json", result)
                raise
            save(evidence / "input.json", {"source": PIN, "source_digest": digest, "root": str(root),
                 "prompt_sha256": sha(task_prompt.encode()), "model": "gpt-6.1-sol", "effort": "high",
                 "cli": command([str(args.codex), "--version"], env).strip()})
            (evidence / "prompt.txt").write_text(task_prompt)
            try:
                if arm == "B":
                    verify = args.protocol.parents[2] / "scripts/verify-tolk.mjs"
                    expectation = args.protocol.parents[2] / "scripts/tolk-expectations/webdom.json"
                    index_log = command([str(args.bundle / "node"), "--liftoff-only", str(verify),
                        "--build", str(args.bundle / "lib/dist"), "--project", str(root),
                        "--expect", str(expectation), "--index", "--report", str(evidence / "index.json")], env)
                    (evidence / "index.stdout").write_text(index_log)
                    prewarm(root, args.bundle, env, evidence)
                else:
                    assert not (root / ".codegraph").exists()
                result["preparation_seconds"] = time.monotonic() - start
                argv = [str(args.codex), "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral",
                        "--strict-config", "--json", "--color", "never", "-s", "read-only", "-m", "gpt-6.1-sol",
                        "-C", str(root), "-o", str(evidence / "answer.md")]
                argv += config(root, args.bundle, arm == "B", Path(env["CODEX_HOME"])) + ["-"]
                save(evidence / "argv.json", argv)
                print(f"START {label} {root}", flush=True)
                start = time.monotonic()
                with (evidence / "stderr.log").open("w") as err:
                    proc = None
                    try:
                        proc = subprocess.Popen(argv, env=env, cwd=root, text=True, stdin=subprocess.PIPE,
                                                stdout=subprocess.PIPE, stderr=err, start_new_session=True)
                        result["pid"] = proc.pid
                        result["status"] = "running"
                        save(evidence / "result.json", result)
                        stdout, _ = proc.communicate(task_prompt, timeout=240)
                        result["status"] = "completed" if proc.returncode == 0 else "failed"
                    except subprocess.TimeoutExpired:
                        stop_group(proc)
                        stdout, _ = proc.communicate()
                        result["status"] = "timeout"
                    finally:
                        if proc is not None:
                            stop_group(proc)
                result.update(seconds=round(time.monotonic() - start, 3), exit_code=proc.returncode)
                events = [json.loads(line) for line in stdout.splitlines() if line.strip()]
                events = [e for e in events if e.get("item", {}).get("type") != "reasoning"]
                (evidence / "events.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events))
                result.update(summarize(events))
                answer = evidence / "answer.md"
                if result["status"] == "completed" and not completed_answer(
                        result, answer.read_text() if answer.exists() else ""):
                    result.update(status="infrastructure-error", exception="Missing completed turn/final answer or stream errors")
                after = sha(b"".join(p.encode() + b"\0" + (root / p).read_bytes() for p in tracked if p))
                result["source_unchanged"] = after == digest
                result["tracked_clean"] = command(["git", "status", "--porcelain", "--untracked-files=no"], env, root) == ""
            except (Exception, KeyboardInterrupt) as exc:
                result.update(status=failure_status(exc), exception=f"{type(exc).__name__}: {exc}")
                raise
            finally:
                try:
                    if arm == "B":
                        code = "const {stopDaemonAt}=require(process.argv[1]);stopDaemonAt(process.argv[2],{preserveUnverified:true}).then(x=>console.log(JSON.stringify(x)))"
                        result["cleanup"] = json.loads(command([str(args.bundle / "node"), "--liftoff-only", "-e", code,
                            str(args.bundle / "lib/dist/mcp/daemon-registry.js"), str(root)], env, timeout=30))
                        if result["cleanup"]["outcome"] not in ("term", "not-running", "no-daemon"):
                            result.update(status="infrastructure-error", cleanup_error="Unacceptable daemon shutdown outcome")
                except Exception as exc:
                    result.update(status="infrastructure-error", cleanup_error=str(exc))
                finally:
                    save(evidence / "result.json", result)
            print(f"END {label} {result['status']} {result.get('seconds')}s tools={result.get('tool_count')}", flush=True)
            if result["status"] != "completed":
                raise RuntimeError(f"{label} failed; retained, no automatic retries")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--task", choices=("W1", "W2", "W3"))
    parser.add_argument("--auth-home", type=Path, help="Existing ChatGPT login directory; config ignored")
    parser.add_argument("--resume", action="store_true", help="Retain terminal attempts; never retry them")
    parser.add_argument("--additional-w1-pair", action="store_true",
                        help="Explicit recovery pair r3 A/B; retain original invalid attempts")
    for name in ("codex", "bundle", "corpus", "protocol", "out"):
        parser.add_argument("--" + name, type=Path)
    args = parser.parse_args()
    if args.self_test:
        self_test()
    else:
        if os.name != "posix":
            parser.error("Run the pilot in Linux/WSL; --self-test also works on Windows")
        if not all(getattr(args, k) for k in ("task", "codex", "bundle", "corpus", "protocol", "out")):
            parser.error("all paths and --task required; use --self-test for offline checks")
        if args.additional_w1_pair and (args.task != "W1" or args.resume):
            parser.error("--additional-w1-pair requires W1 and cannot use --resume")
        signal.signal(signal.SIGTERM, on_terminate)
        run(args)
