# Tolk Codex subscription pilot — 2026-10-27

**The pilot did not demonstrate an agent-efficiency improvement.** Twelve fresh Codex answers were obtained on the three frozen Webdom tasks, twice per arm. Both arms scored **28/30**; CodeGraph was called in **2/6** enabled sessions. This is a Codex pilot requested by the user, not execution of upstream's Sonnet benchmark policy.

The [machine-readable results](tolk-codex-pilot-results.json) retain all fourteen process launches, anonymous grading, input/answer hashes, commands, usage and paired comparisons. The original two infrastructure failures remain visible. No model answer was discarded or retried.

## Inputs and isolation

- Webdom main snapshot [187e0589f437fe398e3385f4a434e9755d1b4d87](https://github.com/webdom-market/webdom-contracts/tree/187e0589f437fe398e3385f4a434e9755d1b4d87), compiler declaration previously checked as Tolk 1.4.1.
- Runtime CodeGraph **79cb5f4d99d37b97bbc5b66202bcbe14d8b5a711**, upstream base **69af19ace270f2e940444d514de6dde971df12df**; package 1.6.2. The existing extracted Linux-x64 bundle was used, not a CLI from PATH.
- Archive SHA-256 **dab7de527ee8f967cb645b8023bd400daed8d6c355bc33a817463f969952307f**; grammar **663a425723b0b71bcb990136149b9cb7be83fee80825fe321b15583ef6ebc921**. Both were checked again.
- Ubuntu-24.04 WSL2/x64; bundled Node 24.22.1; task-local Codex CLI **0.164.0**, requested **gpt-6.1-sol / high** in every completed session. JSONL does not expose an immutable backend model revision.
- The [frozen prompts and rubric](https://github.com/mysteryon88-forks/codegraph/tree/037f989293fd6874f3b7613df7a66046d97b7d1a/docs/benchmarks) preceded the runs. Prompt bytes match within each completed task. All source digests match the same pin; tracked source stayed unchanged.
- Every session used a separate clone in Linux /tmp, a fresh ephemeral context, read-only command sandbox, ignored user config/rules, disabled AGENTS loading, skills, plugins, apps, web and multi-agent tools. Read scope was enforced by instructions and subsequent command audit; read-only mode alone is not filesystem read isolation.
- A had no index or MCP server. B had an independent fresh .codegraph and one required MCP server from the bundle, exposing explore/node. Before timing, initialize, tools/list, daemon identity and socket readiness were checked. Each used B index contained 203 supported files, including all 78 Tolk files; the existing Webdom verifier passed with no missing Tolk files or parse issues.
- ChatGPT login was explicitly required and API credential/base overrides were removed. No Claude, API-key inference, purchases or global configuration changes were used. Account usage snapshots were 75% before preparation and 76% after completion; they include controller/reviewer and other account activity, so that difference is not attributed exclusively to the pilot.

The initial W1-r1-A launch hit an expired Linux token and failed refreshing it. W1-r1-B used the current same-account Windows login but failed routing because WSL did not inherit the Windows loopback proxy. Both had no completed turn, answer, tool calls or recorded token usage. A separate preparatory MCP probe exposed a handshake/socket race in the controller; it was corrected before successful sessions.

The working sessions used the current Windows ChatGPT login with user configuration ignored, plus a temporary loopback-only stdio bridge to the user's existing Windows proxy. The bridge did not terminate TLS or record traffic and was removed afterward. System proxy settings were unchanged. This transport was identical for all twelve completed sessions.

The original no-retry launch cap was explicitly amended after those zero-usage failures and before any grading: append one fresh W1-r3 A/B pair, retain W1-r1, and stop without further replacement if the extra pair failed. Thus there were **14 Codex launches, 12 answers**, not twelve flawless attempts. Original order was W1 A/B then B/A, W2 A/B then B/A, W3 A/B then B/A; recovery W1 A/B ran last. There was no answer-driven selection.

## Results

A = without CodeGraph; B = CodeGraph enabled. Times include Codex startup, MCP attachment and model/tool work, after source/index/daemon preparation; preparation is recorded separately.

| Task / repeat | A seconds | B seconds | A tool items | B tool items | B read/search commands | B explore calls | A/B score |
|---|---:|---:|---:|---:|---:|---:|---|
| W1 / 2 | 31.730 | 30.572 | 4 | 6 | 5 / 1 | 0 | 5 / 5 |
| W1 / 3, recovery | 32.258 | 41.781 | 5 | 7 | 5 / 1 | 0 | 5 / 5 |
| W2 / 1 | 31.257 | 27.570 | 5 | 4 | 0 / 0 | 2 | 5 / 5 |
| W2 / 2 | 29.665 | 30.607 | 3 | 4 | 3 / 0 | 0 | 5 / 5 |
| W3 / 1 | 33.119 | 34.263 | 5 | 8 | 6 / 1 | 0 | 4 / 4 |
| W3 / 2 | 37.933 | 39.533 | 3 | 4 | 1 / 1 | 2 | 4 / 4 |

An independent Sol reviewer graded twelve shuffled answers against the frozen key and pinned source, without arm labels, timing or run logs. This was model grading, not human review. No wrong-contract/TypeScript targets or material wrong source claims were found in the answers. Both arms' W3 answers correctly located the reserve functions but omitted the sibling import "constants" at contracts/fix_price_sales/ton_simple_sale/contract.tolk:13: **4/5 under the unchanged rubric**. This omission is not evidence of a wrong extracted edge. The root checked the reported omission against the saved answers.

The all-completed descriptive medians were **31.994 seconds A / 32.435 seconds B**, and **4.5 / 5 completed tool items**. Those timing medians include W3's partial answers. Restricting performance comparison to the four fully correct pairs gives median paired B/A time **0.99763**; the signs reverse between repeats for both W1 and W2. Neither establishes the proposed consistent >=10% improvement.

The enabled arm issued **20 source-read commands and 4 content-search commands**, versus **16 and 4** without CodeGraph; each arm also had 6 file-listing commands. One command can read multiple files, and a mixed command counts as both read and search. File listings (rg --files) and index-presence metadata checks are separate from content reads. Tool items count completed command/MCP events, not shell subcommands or Claude-native Read/Grep calls.

Only W2-r1-B achieved zero source-read/content-search commands, with one file listing and two explore calls. Both sessions adopting CodeGraph exceeded this small repository's one-explore target. All four actual MCP calls completed without tool errors. Across their responses, the next action was another explore twice, a final answer once, and a source-read/search command once. No CLI/library/SQLite bypass, outside-repository source read, project script execution, network command or source edit appeared in the answering sessions.

The actual MCP responses also included unrelated contracts and TypeScript wrappers. Independent final review did not establish a false Flow/call edge in those responses, but this extra content is retrieval noise; the absence of a tool error does not establish that every returned file was relevant.

Native usage totals, without dollar conversion:

| Arm | Input tokens | Cached input subset | Output tokens |
|---|---:|---:|---:|
| A | 398,387 | 255,744 | 5,485 |
| B | 463,269 | 309,504 | 6,200 |

These are the CLI's single-turn aggregate usage fields. Residual context occupancy is **N/A**: cumulative input tokens do not reveal retained context. Byte-allocation efficiency is **N/A**: no validated Codex adapter for the Claude attribution metric was used. Explore-next-action evidence is reported above. No token/cost saving is claimed.

All recorded model/server/daemon PIDs and the temporary transport helper stopped. A scan for processes serving the unique case roots found none; no Windows bridge helper remained. The original installation, working project index and MCP settings were preserved. Raw answers, sanitized JSONL, readiness/index receipts and anonymous grading remain locally under .tmp-tolk/codex-pilot/; they contain public source excerpts and are not committed.

## Reproduce

Use Linux/WSL with Python 3, a working ChatGPT login/network route and an independently extracted bundle with the hash above. Install a separate Codex 0.164.0 if needed; this does not replace a global CLI:

~~~bash
set -e
npm install --prefix /tmp/tolk-codex-cli --no-audit --no-fund --ignore-scripts @openai/codex@0.164.0
git clone https://github.com/webdom-market/webdom-contracts /tmp/tolk-pilot-webdom
git -C /tmp/tolk-pilot-webdom checkout --detach 187e0589f437fe398e3385f4a434e9755d1b4d87

# Run from the fork. Set explicit absolute paths for this environment.
CODEX_BIN=/tmp/tolk-codex-cli/node_modules/.bin/codex
BUNDLE=/absolute/extracted/codegraph-linux-x64
CORPUS=/tmp/tolk-pilot-webdom
AUTH_HOME="$HOME/.codex"
OUT="$(mktemp -d /tmp/tolk-codex-pilot.XXXXXX)"
python3 scripts/agent-eval/tolk-codex-pilot.py --self-test
for task in W1 W2 W3; do
  python3 scripts/agent-eval/tolk-codex-pilot.py --task "$task" \
    --codex "$CODEX_BIN" --bundle "$BUNDLE" --corpus "$CORPUS" \
    --auth-home "$AUTH_HOME" --protocol "$PWD/docs/benchmarks/tolk-agent-ab.md" \
    --out "$OUT"
done
~~~

The controller runs exactly two counterbalanced repeats per task, caps each session at 240 seconds and stops on a failure. Monitor subscription quota before each task pack; do not buy credits or switch to API billing. A deliberate --resume retains terminal attempts and never retries them. The separately reviewed --additional-w1-pair option creates distinct r3 receipts; it was used only for the documented infrastructure recovery. Keep grading and output outside source copies. The temporary host-proxy bridge was environment-specific and is not installed by the controller.

Only the benchmark controller/docs changed; its offline self-test and receipt/hash/process audits were run. Final review additionally hardened interruption cleanup and tested the SIGTERM handler without a model call; the script hash identifies that final reproducer, while the recorded model inputs/timings are unchanged. The runtime was the already validated archive; npm test/build were not repeated for these benchmark-only changes.

## Remaining acceptance

This pilot supports neither a general speed claim nor upstream merge readiness. It exposed inconsistent tool adoption and an answer-completeness miss under the fixed rubric. It does not identify a new Tolk parser/resolver defect. Medium/large agent packs, the existing-language baseline/new control, human review and upstream's Sonnet-specific/feedback-metric requirements remain open. Any next experiment should be declared separately; these answers and results must remain unchanged.
