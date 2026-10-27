#!/usr/bin/env python3
"""One isolated, subscription-authenticated CTF retrieval A/B case."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import shlex
import signal
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True

MODEL = "gpt-6.1-sol"
EFFORT = "high"
TIMEOUT_SECONDS = 240
EXPECTED_TOLK_FILES = 47
SAFE_DAEMON_OUTCOMES = {"term", "not-running", "no-daemon"}


def _load_pilot():
    path = Path(__file__).resolve().with_name("tolk-codex-pilot.py")
    spec = importlib.util.spec_from_file_location("_tolk_codex_pilot", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the existing Tolk pilot helpers")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


pilot = _load_pilot()


def _digest(data):
    return hashlib.sha256(data).hexdigest()


def _file_digest(path):
    return _digest(path.read_bytes())


def _save(path, value):
    pilot.save(path, value)


def _process_record(evidence, value):
    with (evidence / "processes.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(value, sort_keys=True) + "\n")


def _require_abs(path, name):
    if not path.is_absolute():
        raise ValueError(f"--{name} must be an absolute path")


def _validate_paths(args):
    paths = ("snapshot", "protocol", "expect", "bundle", "codex", "auth_home", "out")
    for name in paths:
        _require_abs(getattr(args, name), name.replace("_", "-"))
    checks = ((args.snapshot, "dir", "snapshot"), (args.protocol, "file", "protocol"),
              (args.expect, "file", "expect"), (args.bundle, "dir", "bundle"),
              (args.codex, "file", "codex"), (args.auth_home, "dir", "auth-home"))
    for path, kind, name in checks:
        if not path.exists() or (kind == "dir" and not path.is_dir()) or (kind == "file" and not path.is_file()):
            raise ValueError(f"--{name} does not name an existing {kind}")
    if args.snapshot.is_symlink():
        raise ValueError("Snapshot root must not be a symlink")
    if not args.out.parent.is_dir():
        raise ValueError("--out parent must already exist")
    required = (args.bundle / "node", args.bundle / "bin/codegraph",
                args.bundle / "lib/dist/mcp/daemon-registry.js")
    if not all(path.is_file() for path in required):
        raise ValueError("Bundle is missing node, the CodeGraph binary, or daemon registry")
    if not (args.bundle / "lib/dist/index.js").is_file():
        raise ValueError("Bundle is missing lib/dist/index.js")
    if not (Path(__file__).resolve().parents[2] / "scripts/verify-tolk.mjs").is_file():
        raise ValueError("Repository scripts/verify-tolk.mjs is unavailable")


def _validate_acton(data):
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("Acton.toml is not UTF-8") from exc
    active = False
    saw_table = False
    cleaned = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            continue
        if "#" in stripped:
            raise ValueError("Acton.toml must contain sanitized import mappings without comments")
        if stripped.startswith("["):
            if stripped != "[import-mappings]" or saw_table:
                raise ValueError("Acton.toml may contain only one [import-mappings] table")
            saw_table = active = True
            cleaned.append(stripped)
        elif not active or not re.fullmatch(r"(?:[A-Za-z0-9_.-]+|\"[^\"]+\"|'[^']+')\s*=\s*.+", stripped):
            raise ValueError("Acton.toml may contain only import-mappings assignments")
        else:
            cleaned.append(stripped)
    if not saw_table:
        raise ValueError("Acton.toml is missing [import-mappings]")
    return ("\n".join(cleaned) + "\n").encode("utf-8")


def _secret_like(relative):
    name = relative.as_posix().casefold()
    return bool(re.search(r"(^|[/._-])(secret|secrets|credential|credentials|mnemonic|seed|wallets|keystore|deployment)([/._-]|$)", name))


def _source_files(root, allow_index=False):
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise ValueError("Source root must be a real directory")
    files = []
    for current, directories, filenames in os.walk(root, followlinks=False):
        current_path = Path(current)
        relative_dir = current_path.relative_to(root)
        if relative_dir == Path("."):
            relative_dir = Path()
        kept = []
        for name in directories:
            child = current_path / name
            rel = child.relative_to(root)
            if child.is_symlink():
                raise ValueError("Snapshot contains a symlink")
            if allow_index and rel == Path(".codegraph"):
                continue
            if len(rel.parts) == 1 and rel.parts[0] in ("contracts", "gen"):
                kept.append(name)
            elif len(rel.parts) > 1 and rel.parts[0] in ("contracts", "gen"):
                kept.append(name)
            else:
                raise ValueError("Source tree contains an unexpected directory")
        directories[:] = kept
        for name in filenames:
            path = current_path / name
            rel = path.relative_to(root)
            if path.is_symlink() or not path.is_file():
                raise ValueError("Snapshot contains a non-regular file")
            if allow_index and rel.parts and rel.parts[0] == ".codegraph":
                continue
            if _secret_like(rel):
                raise ValueError("Snapshot contains a secret-like filename")
            if rel == Path("Acton.toml"):
                files.append((rel, path))
            elif rel.suffix == ".tolk" and len(rel.parts) > 1 and rel.parts[0] in ("contracts", "gen"):
                files.append((rel, path))
            else:
                raise ValueError("Snapshot contains an unsupported file")
    files.sort(key=lambda pair: pair[0].as_posix())
    tolk_count = sum(relative.suffix == ".tolk" for relative, _ in files)
    if tolk_count != EXPECTED_TOLK_FILES:
        raise ValueError(f"Expected {EXPECTED_TOLK_FILES} Tolk files, found {tolk_count}")
    if not any(relative == Path("Acton.toml") for relative, _ in files):
        raise ValueError("Snapshot is missing sanitized Acton.toml")
    return files


def _tree_digest(root, allow_index=False):
    digest = hashlib.sha256()
    files = _source_files(root, allow_index=allow_index)
    for relative, path in files:
        data = path.read_bytes()
        if relative == Path("Acton.toml"):
            data = _validate_acton(data)
        digest.update(relative.as_posix().encode("utf-8") + b"\0" + data)
    return digest.hexdigest(), files


def _copy_snapshot(snapshot, destination):
    files = _source_files(snapshot)
    destination.mkdir(mode=0o700)
    digest = hashlib.sha256()
    for relative, source in files:
        data = source.read_bytes()
        if relative == Path("Acton.toml"):
            data = _validate_acton(data)
        digest.update(relative.as_posix().encode("utf-8") + b"\0" + data)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        target.write_bytes(data)
        try:
            target.chmod(0o600)
        except OSError:
            pass
    return digest.hexdigest()


def _read_protocol(path, task_id, arm):
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or not isinstance(value.get("common"), str):
        raise ValueError("Protocol needs a common string")
    tasks = value.get("tasks")
    if not isinstance(tasks, list):
        raise ValueError("Protocol tasks must be a list")
    matches = [task for task in tasks if isinstance(task, dict) and task.get("id") == task_id]
    if len(matches) != 1 or not isinstance(matches[0].get("prompt"), str) or not isinstance(matches[0].get("file"), str):
        raise ValueError("Protocol must contain exactly one task with id, prompt, and file")
    policies = value.get("mode_policy")
    if not isinstance(policies, dict) or not isinstance(policies.get(arm), str):
        raise ValueError("Protocol is missing the selected arm policy")
    task = matches[0]
    prompt = "\n\n".join((value["common"].strip(), policies[arm].strip(), task["prompt"].strip()))
    if arm == "B":
        prompt += (f"\n\nStart with a successful codegraph_explore question whose query includes the exact project-relative "
                   f"file path `{task['file']}`. Use only CodeGraph explore and node tools.")
    return value, task, prompt


def _session_env(home, auth_home, bundle, arm):
    env = pilot.clean_env(home, auth_home)
    env["PATH"] = str(bundle) + os.pathsep + env.get("PATH", "")
    if arm == "A":
        env.pop("CODEGRAPH_MCP_TOOLS", None)
    else:
        env.update(CODEGRAPH_MCP_TOOLS="explore,node", CODEGRAPH_NO_UPDATE_CHECK="1",
                   CODEGRAPH_WASM_RELAUNCHED="1")
    return env


def _codex_config(project, bundle, auth_home, arm):
    values = pilot.config(project, bundle, arm == "B", auth_home)
    values += ["-c", "project_doc_max_bytes=0"]
    if arm == "B":
        values += ["-c", "features.shell_tool=false", "-c", "features.view_image=false",
                   "-c", "features.code_mode=false", "-c", "features.code_mode_only=false",
                   "-c", 'mcp_servers.codegraph.env={CODEGRAPH_MCP_TOOLS="explore,node",'
                   'CODEGRAPH_NO_UPDATE_CHECK="1",CODEGRAPH_WASM_RELAUNCHED="1"}']
    else:
        values += ["-c", "features.shell_tool=true"]
    return values


def _run_tracked(argv, env, evidence, name, timeout=180, cwd=None):
    stdout_path, stderr_path = evidence / f"{name}.stdout", evidence / f"{name}.stderr"
    started = time.monotonic()
    process = None
    record = {"name": name, "argv": [str(arg) for arg in argv]}
    with stdout_path.open("w", encoding="utf-8") as stdout, stderr_path.open("w", encoding="utf-8") as stderr:
        try:
            process = subprocess.Popen([str(arg) for arg in argv], env=env, cwd=cwd, stdin=subprocess.DEVNULL,
                                       stdout=stdout, stderr=stderr, text=True, start_new_session=True)
            record["pid"] = process.pid
            _process_record(evidence, record.copy())
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            if process is not None:
                _stop_process(process)
            record.update(timed_out=True, returncode=process.returncode if process else None)
            raise TimeoutError(f"{name} exceeded {timeout} seconds") from exc
        finally:
            if process is not None:
                _stop_process(process)
                record.update(returncode=process.returncode,
                              seconds=round(time.monotonic() - started, 3))
                _process_record(evidence, record.copy())
    return process.returncode, stdout_path.read_text(encoding="utf-8", errors="replace")


def _stop_process(process):
    if process.poll() is None:
        try:
            pilot.stop_group(process)
        except ProcessLookupError:
            process.wait()


def _stop_daemon(project, bundle, env, evidence):
    code = "const {stopDaemonAt}=require(process.argv[1]);stopDaemonAt(process.argv[2],{preserveUnverified:true}).then(x=>console.log(JSON.stringify(x)))"
    argv = [bundle / "node", "--liftoff-only", "-e", code,
            bundle / "lib/dist/mcp/daemon-registry.js", project]
    returncode, output = _run_tracked(argv, env, evidence, "daemon-stop", timeout=30)
    if returncode != 0:
        raise RuntimeError("stopDaemonAt exited unsuccessfully")
    try:
        result = json.loads([line for line in output.splitlines() if line.strip()][-1])
    except (ValueError, IndexError) as exc:
        raise RuntimeError("stopDaemonAt returned no JSON result") from exc
    if result.get("outcome") not in SAFE_DAEMON_OUTCOMES:
        raise RuntimeError("stopDaemonAt did not report a safe shutdown outcome")
    return result


def _validate_index(report_path):
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if (report.get("success") is not True or len(report.get("discovered", [])) != EXPECTED_TOLK_FILES
            or len(report.get("indexed", [])) != EXPECTED_TOLK_FILES or report.get("missing")
            or report.get("parseIssues")):
        raise RuntimeError("B index did not verify the expected 47 Tolk files without parse or missing-file issues")
    return {"indexed_files": len(report["indexed"]), "parse_issues": 0, "missing_files": 0,
            "verification_success": True, "index_duration_ms": report.get("indexDurationMs")}


def _completed_items(events):
    items = {}
    for event in events:
        if event.get("type") == "item.completed" and isinstance(event.get("item"), dict):
            item = event["item"]
            items[item.get("id", f"no-id-{len(items)}")] = item
    return list(items.values())


def _tool_items(events):
    non_tools = {"agent_message", "assistant_message", "user_message", "reasoning"}
    return [item for item in _completed_items(events) if item.get("type") not in non_tools]


def _tool_failed(item):
    if item.get("isError") is True or item.get("is_error") is True or item.get("error"):
        return True
    if item.get("status") in ("error", "failed"):
        return True
    result = item.get("result")
    return isinstance(result, dict) and (result.get("isError") is True or bool(result.get("error")))


def _mcp_fields(item):
    return (item.get("server") or item.get("server_name"),
            item.get("tool") or item.get("tool_name"),
            item.get("arguments"))


def _arguments(value):
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            return None
    return None


def _compliance(events, arm, task_file):
    tools = _tool_items(events)
    violations = []
    known_tool_types = {"mcp_tool_call", "command_execution", "web_search", "file_change"}
    for item in tools:
        if item.get("type") not in known_tool_types:
            violations.append(f"unexpected-tool-type:{item.get('type', 'missing')}")
    if arm == "A":
        for item in tools:
            kind = item.get("type")
            if kind in ("mcp_tool_call", "file_change", "web_search"):
                violations.append(f"forbidden-A-tool:{kind}")
            if kind == "command_execution" and _a_command_violation(item.get("command", "")):
                violations.append("forbidden-A-codegraph-or-database-command")
        return {"valid": not violations, "violations": violations,
                "completed_tool_count": len(tools), "successful_relevant_explores": 0}

    first = tools[0] if tools else None
    if first is None:
        violations.append("missing-first-tool")
    else:
        server, tool, raw_arguments = _mcp_fields(first)
        arguments = _arguments(raw_arguments)
        query = arguments.get("query") if arguments else None
        if first.get("type") != "mcp_tool_call" or server != "codegraph" or tool != "codegraph_explore":
            violations.append("first-tool-not-codegraph-explore")
        if not isinstance(query, str) or task_file not in query:
            violations.append("first-explore-query-missing-task-file")
        if _tool_failed(first):
            violations.append("first-explore-failed")

    successful_relevant_explores = 0
    for item in tools:
        kind = item.get("type")
        if kind != "mcp_tool_call":
            violations.append(f"forbidden-B-tool:{kind}")
            continue
        server, tool, raw_arguments = _mcp_fields(item)
        arguments = _arguments(raw_arguments)
        if server != "codegraph" or tool not in ("codegraph_explore", "codegraph_node"):
            violations.append("forbidden-B-mcp-server-or-tool")
        if _tool_failed(item):
            violations.append("B-tool-error")
        if server == "codegraph" and tool == "codegraph_explore" and arguments:
            query = arguments.get("query")
            if isinstance(query, str) and task_file in query and not _tool_failed(item):
                successful_relevant_explores += 1
    if successful_relevant_explores == 0:
        violations.append("missing-successful-relevant-explore")
    return {"valid": not violations, "violations": violations,
            "completed_tool_count": len(tools),
            "successful_relevant_explores": successful_relevant_explores}


def _a_command_violation(command):
    try:
        outer = shlex.split(command)
        if len(outer) == 3 and Path(outer[0]).name in {"bash", "sh", "zsh"} and outer[1] in {"-c", "-lc"}:
            command = outer[2]
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|\n")
        lexer.whitespace = lexer.whitespace.replace("\n", "")
        lexer.whitespace_split = True
        segments = [[]]
        for token in lexer:
            if token and all(c in ";&|\n" for c in token):
                segments.append([])
            else:
                segments[-1].append(token)
    except ValueError:
        return True
    for tokens in segments:
        if not tokens:
            continue
        text = " ".join(tokens).casefold()
        program = Path(tokens[0]).name
        metadata = (program == "rg" and "--files" in tokens) or program in {"ls", "test", "["}
        metadata |= program == "find" and not any(t.startswith(("-exec", "-ok", "-delete")) for t in tokens)
        # A glob naming the index is metadata, while a later shell command may read its contents.
        if not metadata and ".codegraph" in text:
            return True
        if re.search(r"(?<![.\w@-])(?:[\w./\\-]+[/\\])?codegraph(?:\.(?:js|mjs|cjs|exe))?\s+(?:explore|node|query|status|index|sync|files|context|affected|serve|install|init|uninit|ui|web|--help|--version)\b", text):
            return True
        if re.search(r"\b(?:npx|npm\s+(?:exec|install|i))\b[^;&|]*\b(?:@colbymchenry/)?codegraph\b", text):
            return True
        if re.search(r"\b(?:node|python(?:\d+(?:\.\d+)*)?)\b[^;&|]*(?:require\s*\(|from\s+|import\s*(?:\(|\s+))[^;&|]*codegraph", text):
            return True
    return False


def _filter_events(stdout):
    events = []
    unparsed = []
    for line in stdout.splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            unparsed.append(line)
            continue
        if not isinstance(event, dict):
            unparsed.append(line)
            continue
        item = event.get("item") if isinstance(event, dict) else None
        if (isinstance(item, dict) and item.get("type") == "reasoning") or (
                isinstance(event, dict) and event.get("type") == "reasoning"):
            continue
        events.append(event)
    return events, unparsed


def _write_events(path, events):
    path.write_text("".join(json.dumps(event, separators=(",", ":")) + "\n" for event in events), encoding="utf-8")


def _run_codex(argv, prompt, env, evidence, result):
    stderr_path = evidence / "stderr.log"
    started = time.monotonic()
    process = None
    status = "failed"
    stdout = ""
    failure = None
    with stderr_path.open("w", encoding="utf-8") as stderr:
        try:
            process = subprocess.Popen(argv, env=env, cwd=result["project"], text=True,
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
                                       start_new_session=True)
            result.update(pid=process.pid, status="running")
            _save(evidence / "result.json", result)
            _process_record(evidence, {"name": "codex-exec", "pid": process.pid, "argv": argv})
            stdout, _ = process.communicate(prompt, timeout=TIMEOUT_SECONDS)
            status = "completed" if process.returncode == 0 else "failed"
        except subprocess.TimeoutExpired:
            _stop_process(process)
            stdout, _ = process.communicate()
            status = "timeout"
        except BaseException as exc:
            failure = exc
            status = pilot.failure_status(exc)
        finally:
            if process is not None:
                _stop_process(process)
                if failure is not None:
                    try:
                        stdout, _ = process.communicate(timeout=5)
                    except Exception as capture_error:
                        result["evidence_capture_error"] = type(capture_error).__name__
                _process_record(evidence, {"name": "codex-exec", "pid": process.pid,
                                           "returncode": process.returncode,
                                           "seconds": round(time.monotonic() - started, 3)})
    result.update(seconds=round(time.monotonic() - started, 3), exit_code=process.returncode if process else None)
    events, unparsed = _filter_events(stdout)
    _write_events(evidence / "stdout.jsonl", events)
    _write_events(evidence / "events.jsonl", events)
    if unparsed:
        # Truncated records can contain reasoning; retain the diagnostic count rather than raw payload.
        _save(evidence / "stdout-unparsed.json", {"discarded_lines": len(unparsed)})
    result.update(pilot.summarize(events))
    result["status"] = status
    if failure is not None:
        raise failure
    return events


def _run_index(project, args, env, evidence):
    verify = Path(__file__).resolve().parents[2] / "scripts/verify-tolk.mjs"
    report = evidence / "index.json"
    argv = [args.bundle / "node", "--liftoff-only", verify, "--build", args.bundle / "lib/dist",
            "--project", project, "--expect", args.expect, "--index", "--report", report]
    code, _ = _run_tracked(argv, env, evidence, "index", timeout=600)
    if code != 0:
        raise RuntimeError("Tolk index verification exited unsuccessfully")
    return _validate_index(report)


def run(args):
    evidence = args.out
    if not evidence.is_absolute():
        raise ValueError("--out must be absolute")
    if evidence.exists():
        raise FileExistsError("Refusing to overwrite an existing case output")
    if not evidence.parent.is_dir():
        raise ValueError("--out parent must already exist")
    evidence.mkdir()
    label = f"{args.task}-r{args.repeat}-{args.arm}"
    result = {"schema_version": 1, "label": label, "task": args.task, "repeat": args.repeat,
              "arm": args.arm, "status": "preparation", "controller_pid": os.getpid(),
              "started_at": datetime.now(timezone.utc).isoformat(), "project": None}
    _save(evidence / "result.json", result)
    previous_handler = None
    temp_area = None
    project = None
    env = None
    prompt = None
    source_digest = None
    codex_process = None
    case_started = time.monotonic()
    model_started = None
    try:
        _validate_paths(args)
        if os.name != "posix":
            raise RuntimeError("Run a case in Linux/WSL; --self-test is offline on Windows")
        previous_handler = signal.signal(signal.SIGTERM, pilot.on_terminate)
        protocol, task, prompt = _read_protocol(args.protocol, args.task, args.arm)
        temp_area = Path(tempfile.mkdtemp(prefix="cg-tolk-ab-"))
        project = temp_area / "repo"
        source_digest = _copy_snapshot(args.snapshot, project)
        result.update(project=str(project), temp_area=str(temp_area), source_sha256=source_digest)
        _save(evidence / "result.json", result)
        copied_digest, _ = _tree_digest(project)
        if copied_digest != source_digest:
            raise RuntimeError("Copied source digest does not match the snapshot")

        home = evidence / "empty-home"
        home.mkdir(mode=0o700)
        env = _session_env(home, args.auth_home, args.bundle, args.arm)
        auth_path = args.auth_home / "auth.json"
        auth = json.loads(auth_path.read_text(encoding="utf-8"))
        if auth.get("auth_mode") != "chatgpt":
            raise RuntimeError("Existing ChatGPT subscription login required")
        del auth

        codex_code, codex_version = _run_tracked([args.codex, "--version"], env, evidence, "codex-version", timeout=30)
        node_code, node_version = _run_tracked([args.bundle / "node", "--version"], env, evidence, "node-version", timeout=30)
        if codex_code != 0 or node_code != 0:
            raise RuntimeError("Could not read Codex or bundled Node version")
        (evidence / "prompt.txt").write_text(prompt, encoding="utf-8")
        input_record = {"task": args.task, "repeat": args.repeat, "arm": args.arm,
                        "model": MODEL, "effort": EFFORT, "codex_version": codex_version.strip(),
                        "node_version": node_version.strip(), "prompt_sha256": _digest(prompt.encode()),
                        "protocol_sha256": _file_digest(args.protocol), "expect_sha256": _file_digest(args.expect),
                        "codex_sha256": _file_digest(args.codex), "source_snapshot_sha256": source_digest,
                        "paths": {key: str(getattr(args, key)) for key in
                                  ("snapshot", "protocol", "expect", "bundle", "codex", "auth_home", "out")}}
        _save(evidence / "input.json", input_record)

        if args.arm == "B":
            started = time.monotonic()
            result["index"] = _run_index(project, args, env, evidence)
            result["index_seconds"] = round(time.monotonic() - started, 3)
            started = time.monotonic()
            pilot.prewarm(project, args.bundle, env, evidence)
            result["prewarm_seconds"] = round(time.monotonic() - started, 3)
            pid_file = evidence / "prewarm-pid.json"
            if pid_file.exists():
                _process_record(evidence, {"name": "mcp-prewarm", **json.loads(pid_file.read_text(encoding="utf-8"))})
            readiness = evidence / "readiness.json"
            if readiness.exists():
                ready = json.loads(readiness.read_text(encoding="utf-8"))
                result["daemon_pid"] = ready.get("daemon", {}).get("pid")
        else:
            if (project / ".codegraph").exists():
                raise RuntimeError("A project copy unexpectedly contains a CodeGraph index")

        result["preparation_seconds"] = round(time.monotonic() - case_started, 3)
        _save(evidence / "input.json", input_record)
        argv = [str(args.codex), "exec", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
                "--ephemeral", "--strict-config", "--json", "--color", "never", "-s", "read-only",
                "-m", MODEL, "-C", str(project), "-o", str(evidence / "answer.md")]
        argv += _codex_config(project, args.bundle, args.auth_home, args.arm) + ["-"]
        _save(evidence / "argv.json", argv)
        result.update(status="running", argv_sha256=_digest(json.dumps(argv, separators=(",", ":")).encode()))
        _save(evidence / "result.json", result)
        model_started = time.monotonic()
        events = _run_codex(argv, prompt, env, evidence, result)
        result["completion_seconds"] = round(time.monotonic() - model_started, 3)
        compliance = _compliance(events, args.arm, task["file"])
        result["compliance"] = compliance
        if not compliance["valid"]:
            result["status"] = "protocol-error"
        elif result["status"] == "completed" and not pilot.completed_answer(
                result, (evidence / "answer.md").read_text(encoding="utf-8")
                if (evidence / "answer.md").exists() else ""):
            result.update(status="infrastructure-error", exception="Missing completed turn/final answer or stream errors")
        try:
            after_digest, _ = _tree_digest(project, allow_index=True)
            result["source_unchanged"] = after_digest == source_digest
        except ValueError as exc:
            result["source_unchanged"] = False
            result["source_check_error"] = str(exc)
            result.update(status="protocol-error")
        if args.arm == "A" and (project / ".codegraph").exists():
            result.setdefault("compliance", {"valid": False, "violations": []})
            result["compliance"]["valid"] = False
            result["compliance"]["violations"].append("A-created-codegraph-index")
            result["status"] = "protocol-error"
        snapshot_after, _ = _tree_digest(args.snapshot)
        result["snapshot_unchanged"] = snapshot_after == source_digest
        if not result["source_unchanged"]:
            result["status"] = "protocol-error"
            result.setdefault("exception", "Source files or project contents changed during the case")
        if not result["snapshot_unchanged"]:
            if result["status"] != "protocol-error":
                result.update(status="infrastructure-error", exception="Source digest changed during the case")
    except (Exception, KeyboardInterrupt) as exc:
        detail = f"{type(exc).__name__}: {exc}"
        if result.get("status") == "protocol-error":
            result.setdefault("secondary_errors", []).append(detail)
        else:
            result.update(status=pilot.failure_status(exc), exception=detail)
    finally:
        try:
            if args.arm == "B" and project is not None and env is not None and project.exists():
                try:
                    result["cleanup"] = _stop_daemon(project, args.bundle, env, evidence)
                except Exception as exc:
                    result["cleanup_error"] = f"{type(exc).__name__}: {exc}"
                    if result.get("status") != "protocol-error":
                        result["status"] = "infrastructure-error"
            if project is not None and project.exists():
                try:
                    shutil.rmtree(temp_area)
                    result["temporary_source_removed"] = True
                except Exception as exc:
                    result["temporary_source_removed"] = False
                    result["temporary_source_cleanup_error"] = f"{type(exc).__name__}: {exc}"
                    if result.get("status") != "protocol-error":
                        result["status"] = "infrastructure-error"
        finally:
            if previous_handler is not None:
                signal.signal(signal.SIGTERM, previous_handler)
            result["finished_at"] = datetime.now(timezone.utc).isoformat()
            if model_started is None:
                result["preparation_elapsed_seconds"] = round(time.monotonic() - case_started, 3)
            _save(evidence / "result.json", result)
    return 0 if result.get("status") == "completed" else 1


def _self_test():
    task_file = "contracts/Contract.tolk"

    def completed(item):
        return {"type": "item.completed", "item": item}

    explore = {"id": "e1", "type": "mcp_tool_call", "server": "codegraph",
               "tool": "codegraph_explore", "arguments": json.dumps({"query": f"handleMessage {task_file}"}),
               "result": {"isError": False}}
    node = {"id": "n1", "type": "mcp_tool_call", "server": "codegraph",
            "tool": "codegraph_node", "arguments": {"name": "handleMessage"}, "result": {"isError": False}}
    valid_b = [completed({"id": "m", "type": "agent_message"}), completed(explore), completed(node)]
    assert _compliance(valid_b, "B", task_file)["valid"]
    assert not _compliance([completed(node)], "B", task_file)["valid"]  # node-first / missing explore
    assert not _compliance([completed({**explore, "server": "other"})], "B", task_file)["valid"]
    assert not _compliance([completed({**explore, "isError": True})], "B", task_file)["valid"]
    assert not _compliance([completed({**explore, "arguments": {"query": "other.tolk"}})], "B", task_file)["valid"]
    assert not _compliance([completed({"id": "s", "type": "command_execution", "command": "ls"}),
                            completed(explore)], "B", task_file)["valid"]
    assert not _compliance([completed({**explore, "tool": "other_tool"})], "B", task_file)["valid"]

    valid_a = [completed({"id": "c", "type": "command_execution", "command": "sed -n '1,10p' " + task_file})]
    assert _compliance(valid_a, "A", task_file)["valid"]
    for command in ("/bin/bash -lc 'pwd; rg --files -g .codegraph -g *.tolk'", "ls -d .codegraph",
                    "rg --files -g '*.tolk' -g '!.codegraph/**'",
                    "/bin/bash -lc \"pwd; rg --files -g '*.tolk' -g '!.codegraph/**'\""):
        assert not _a_command_violation(command)
        assert _compliance([completed({"id": "meta", "type": "command_execution", "command": command})],
                           "A", task_file)["valid"]
    for command in ("codegraph explore handleMessage", "cat .codegraph/codegraph.db",
                    "rg --files -g '!.codegraph/**'; cat .codegraph/codegraph.db",
                    "rg --files -g '*.tolk'\ncat .codegraph/codegraph.db",
                    "/bin/bash -lc 'rg --files -g *.tolk\ncat .codegraph/codegraph.db'",
                    "/bin/bash -lc 'codegraph explore handleMessage'",
                    "sqlite3 .codegraph/codegraph.db 'select 1'",
                    "node -e \"require('@colbymchenry/codegraph')\""):
        assert _a_command_violation(command)
    for item in (explore, {"id": "f", "type": "file_change"},
                 {"id": "w", "type": "web_search"},
                 {"id": "bad", "type": "command_execution", "command": "codegraph status"}):
        assert not _compliance([completed(item)], "A", task_file)["valid"]

    with tempfile.TemporaryDirectory(prefix="cg-tolk-ab-selftest-") as temp:
        base = Path(temp)
        home, auth_home, bundle = base / "home", base / "auth", base / "bundle"
        home.mkdir(); auth_home.mkdir(); bundle.mkdir()
        sentinel_names = ("OPENAI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY", "CODEX_API_KEY", "CODEGRAPH_TEST_SECRET")
        previous = {name: os.environ.get(name) for name in sentinel_names}
        try:
            for name in sentinel_names:
                os.environ[name] = "private-sentinel"
            env_a = _session_env(home, auth_home, bundle, "A")
            env_b = _session_env(home, auth_home, bundle, "B")
            assert all(name not in env_a and name not in env_b for name in sentinel_names)
            assert "CODEGRAPH_MCP_TOOLS" not in env_a
            assert env_b["CODEGRAPH_MCP_TOOLS"] == "explore,node"
            assert env_b["CODEGRAPH_NO_UPDATE_CHECK"] == "1" and env_b["CODEGRAPH_WASM_RELAUNCHED"] == "1"
            assert env_b["PATH"].split(os.pathsep)[0] == str(bundle)
        finally:
            for name, value in previous.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value
        cfg_a = _codex_config(base / "repo", bundle, auth_home, "A")
        cfg_b = _codex_config(base / "repo", bundle, auth_home, "B")
        text_a, text_b = " ".join(cfg_a), " ".join(cfg_b)
        assert "mcp_servers.codegraph" not in text_a
        assert 'CODEGRAPH_MCP_TOOLS="explore,node"' in text_b
        assert "features.shell_tool=false" in text_b and "features.view_image=false" in text_b
        assert "features.code_mode=false" in text_b and "features.code_mode_only=false" in text_b
        assert "features.shell_tool=true" in text_a

        from unittest.mock import patch

        partial = json.dumps(completed({"id": "partial", "type": "command_execution",
                                        "command": "nl contracts/Contract.tolk"})) + "\n"
        partial += json.dumps(completed({"id": "r", "type": "reasoning", "text": "synthetic-hidden-fragment"})) + "\n"
        partial += '{"item":{"type":"reasoning","text":"synthetic-hidden-fragment'
        for error_type in (KeyboardInterrupt, OSError):
            evidence = base / error_type.__name__
            evidence.mkdir()

            class InterruptedProcess:
                pid = 123456
                returncode = None
                calls = 0

                def poll(self):
                    return self.returncode

                def communicate(self, *args, **kwargs):
                    self.calls += 1
                    if self.calls == 1:
                        raise error_type("synthetic interruption")
                    return partial, None

            process = InterruptedProcess()
            state = {"project": str(base)}
            with patch.object(subprocess, "Popen", return_value=process), patch.object(
                    pilot, "stop_group", side_effect=lambda proc: setattr(proc, "returncode", -15)):
                try:
                    _run_codex(["synthetic-codex"], "synthetic prompt", {}, evidence, state)
                    raise AssertionError("interruption was swallowed")
                except error_type:
                    pass
            assert process.returncode == -15
            assert state["seconds"] >= 0 and state["exit_code"] == -15
            saved = (evidence / "events.jsonl").read_text(encoding="utf-8")
            assert '"command_execution"' in saved and '"reasoning"' not in saved
            assert all("synthetic-hidden-fragment" not in p.read_text(encoding="utf-8")
                       for p in evidence.iterdir() if p.is_file())

        snapshot = base / "snapshot"
        for directory, count in (("contracts", 25), ("gen", 22)):
            target = snapshot / directory
            target.mkdir(parents=True)
            for number in range(count):
                (target / f"file{number}.tolk").write_text("// synthetic self-test\n", encoding="utf-8")
        (snapshot / "Acton.toml").write_text('[import-mappings]\n"@lib" = "contracts/lib"\n', encoding="utf-8")
        copied = base / "copied"
        source_hash = _copy_snapshot(snapshot, copied)
        copied_hash, _ = _tree_digest(copied)
        assert source_hash == copied_hash and len(_source_files(copied)) == 48
        (copied / ".codegraph").mkdir()
        assert _tree_digest(copied, allow_index=True)[0] == source_hash
        try:
            (snapshot / "extra.json").write_text("{}", encoding="utf-8")
            _source_files(snapshot)
            raise AssertionError("unsupported snapshot file was accepted")
        except ValueError:
            pass
        try:
            _validate_acton(b"[secrets]\nvalue = 'x'\n")
            raise AssertionError("non-import Acton table was accepted")
        except ValueError:
            pass
    print("self-test passed (offline; synthetic events and snapshot only)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--snapshot", type=Path)
    parser.add_argument("--protocol", type=Path)
    parser.add_argument("--expect", type=Path)
    parser.add_argument("--bundle", type=Path)
    parser.add_argument("--codex", type=Path)
    parser.add_argument("--auth-home", type=Path)
    parser.add_argument("--out", type=Path, help="New output directory for this single case (must not exist)")
    parser.add_argument("--task", choices=("C1", "C2", "C3"))
    parser.add_argument("--repeat", choices=("1", "2"))
    parser.add_argument("--arm", choices=("A", "B"))
    args = parser.parse_args()
    if args.self_test:
        _self_test()
        return 0
    required = ("snapshot", "protocol", "expect", "bundle", "codex", "auth_home", "out", "task", "repeat", "arm")
    if any(getattr(args, name) is None for name in required):
        parser.error("all paths, --task, --repeat, and --arm are required; use --self-test for offline checks")
    args.repeat = int(args.repeat)
    try:
        return run(args)
    except (Exception, KeyboardInterrupt) as exc:
        print(f"case could not start: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
