# Tolk explore repair and unchanged Codex rerun — 2026-10-27

**The file-pinned source-selection defect is fixed; this rerun does not demonstrate an agent-efficiency gain.** All three deterministic questions now return the required declarations/imports in one response without unrelated contract or wrapper sections. All twelve fresh Codex answers completed, but none of the six CodeGraph-enabled sessions made an MCP call. The experiment therefore did not exercise the repaired output during model answering.

The [original pilot](tolk-codex-pilot.md) and [original data](tolk-codex-pilot-results.json) are unchanged. This [new data file](tolk-codex-explore-comparison-results.json) preserves all new attempts, commands, grades, hashes and comparisons. No session was discarded, repeated or replaced.

## Source repair and identity

The repair starts at `60bbb4488b2e6e9fcaa3151bf8307fabfed844fb`; its runtime/build inputs equal the previously tested `79cb5f4d99d37b97bbc5b66202bcbe14d8b5a711`. The upstream base remains `69af19ace270f2e940444d514de6dde971df12df`, package 1.6.2. No upstream update is mixed into the comparison. The data file identifies the candidate by this full base plus SHA-256 of its exact source/test overlays and extracted distribution manifest.

Ordinary context gathering previously admitted the pinned contract, then global symbol seeds and bidirectional traversal reintroduced other contracts and wrappers. The repair limits explicitly Tolk-pinned queries to outgoing dependencies (three hops/200 nodes), includes needed imports and same-file receiver/type declarations, and scopes Flow, caller notes and source pointers consistently. It retains genuine shared helpers without pulling in other callers of those helpers. Source ranking preserves named helpers and small import clusters inside existing budgets. It does not invent a `complete_deal` definition for the original misspelling; the actual reachable `completeDeal` body is shown and the unknown-name warning remains honest.

Unpinned/mixed-language queries and the viewer omit this optional scope. Caller summaries explicitly say they cover this dependency scope, not the complete impact radius. File/byte limits, exact coordinates, path protection and session dedup remain active. No parser, resolver or stored graph change is introduced by this repair; an index produced by the retained runtime does not need rebuilding solely for source selection.

Independent pre-model Sol review accepted the exact four source/test hashes, checked all three responses and matched all 838 numbered source lines to the pinned public source. Synthetic tests cover namesakes, shared-helper callers, outside-directory dependencies, imports, receiver types, depth/node bounds, file/line pins, budgets and dedup.

## Deterministic and standalone acceptance

Same Webdom main snapshot `187e0589f437fe398e3385f4a434e9755d1b4d87`, declared Tolk 1.4.1. W2/W3 use the recorded first queries; W1 uses a source-derived path/symbol query fixed before model runs. Counts are total JavaScript string characters, including response framing, rather than source-budget limits.

| Question | Old characters | New characters | Required source and forbidden sections |
|---|---:|---:|---|
| W1 | 24,945 | 19,683 | PASS |
| W2 | 24,428 | 19,518 | PASS |
| W3 | 21,182 | 9,395 | PASS |

The new [MCP cases](../../scripts/tolk-expectations/webdom-explore-scoped-mcp.json) check actual helper bodies, the right-payment branch, local imports (including swap line 8 and sale line 13), and absence of unrelated contract/wrapper file sections. They run through the existing `verify-tolk-mcp.cjs`, not a mock response.

The official `bash scripts/build-bundle.sh linux-x64 v24.22.1` recipe completed. The downloaded Node archive matched Node.js SHASUMS256; viewer and 30 grammars were present. The archive was extracted outside the development checkout. Its developer `dist` was hidden throughout version/index/MCP acceptance and restored afterward. A separate fresh Webdom clone/index passed the existing graph oracle: 78/78 Tolk files, no missing files or parse diagnostics. Actual MCP initialize, tools/list, three query cases and graceful exit 0 passed. The bundle uses WASM, matching the original artifact; no native extraction kernel is included.

Artifact: `release/codegraph-tolk-explore-linux-x64.tar.gz` (61,161,475 bytes). SHA-256:

```text
dcb4b75fdbf3675a9ce1c65bfbb8b0e74d208a93442de2f06b55aba4913e9208
```

Grammar remains `663a425723b0b71bcb990136149b9cb7be83fee80825fe321b15583ef6ebc921`. This is a test artifact; it was not activated as the user's installation.

## Same twelve-session Codex pilot

Same task prompts and source digests as every matching completed original attempt; unchanged controller SHA `c093f525eabcf652e290742ff55453a66f1e695107a2a1b5d3a9f42404929261`, Codex 0.164.0 wrapper/native hashes, `gpt-6.1-sol/high`, read-only/ephemeral sessions, ignored user rules/config, AGENTS loading disabled, and skills/apps/plugins/web/multi-agent disabled. Each task ran A/B then B/A. A had no index/server; each B had an independent 203-file index with 78 Tolk files and initialize/tools/socket readiness before timing. Preparation is separate. Timeout 240 seconds; 12 launches/12 answers, zero infrastructure replacements. There was no forced-tool policy or answer-driven tuning.

ChatGPT subscription authentication and the same temporary loopback proxy transport were used, with API credential overrides removed. Account usage snapshots were 83% before model packs and 85% after models/grading; they include other account activity. Credit balance remained 38078.0748820000; no purchases/API fallback. The backend model revision is not exposed. Other CPU-intensive work was observed on the shared WSL machine; timing and older/newer samples are descriptive, not a controlled causal estimate.

An independent Sol critic graded shuffled task-prefixed answers against the unchanged source key without arm/timing/log/map access. Root verified the anonymous-to-raw byte binding and hashes before unblinding. This is model grading, not human review. Both arms scored 28/30; all four W3 answers again omitted local `import "constants"`. No critical false target or material wrong-source claim was found.

| Task / repeat | A seconds | B seconds | A/B tool items | A/B score |
|---|---:|---:|---:|---:|
| W1 / 1 | 36.675 | 30.467 | 6 / 4 | 5 / 5 |
| W1 / 2 | 32.095 | 39.412 | 7 / 3 | 5 / 5 |
| W2 / 1 | 35.273 | 34.531 | 3 / 6 | 5 / 5 |
| W2 / 2 | 25.619 | 33.877 | 5 / 4 | 5 / 5 |
| W3 / 1 | 33.919 | 33.983 | 5 / 9 | 4 / 4 |
| W3 / 2 | 44.754 | 39.996 | 7 / 7 | 4 / 4 |

| Metric | Old A | Old B | New A | New B |
|---|---:|---:|---:|---:|
| Score /30 | 28 | 28 | 28 | 28 |
| Input tokens | 398,387 | 463,269 | 431,664 | 465,290 |
| Cached input subset | 255,744 | 309,504 | 302,976 | 321,920 |
| Output tokens | 5,485 | 6,200 | 5,976 | 5,718 |
| Source-read commands | 16 | 20 | 21 | 23 |
| Content-search commands | 4 | 4 | 6 | 5 |
| File-listing commands | 6 | 6 | 7 | 7 |
| MCP-adopting sessions /6 | 0 | 2 | 0 | 0 |
| Median seconds, all completed |31.994|32.435|34.596|34.257|
| Median completed tool items |4.5|5|5.5|5.0|

The four fully correct paired tasks have median B/A time **1.10347** (B about 10.3% slower); old paired ratio was 0.99763. W3 partial answers are excluded from that correctness-conditioned metric. All-completed medians alone look about 1% faster for B, while B used more input tokens and source-read commands. Neither establishes the planned consistent improvement. These are six samples per arm with large repeat variation.

**No new B session called explore or node; none was source-read-free.** Thus after-explore sufficiency is N/A for this model sample, and it cannot attribute any time/token difference to the repaired selection logic. No new graph-answer error is implied either: the model answering path never queried that graph. Residual retained-context occupancy and byte-allocation attribution remain N/A, as in the original pilot. Native token totals are not converted to subscription dollar savings.

## Codex host diagnostic and limits of the inference

A separate post-run **zero-inference** Codex App Server 0.164.0 `mcpServerStatus/list` check returned the candidate's `codegraph_explore`, server 1.6.2 and no tools-discovery error. This used an empty CODEX_HOME and the same explicit MCP entry; it demonstrates that this client can discover the primary tool, not which tool definitions each earlier model request received. The [official method reference](https://learn.chatgpt.com/docs/app-server) describes that inventory endpoint.

That inventory exposed only explore. Direct readiness/MCP-client checks saw explore and node, but setting `CODEGRAPH_MCP_TOOLS` only on the parent process did not establish node exposure through Codex. The initial diagnostic expected both and its assertion failed; a preceding attempt also rejected exec-only ignore flags on app-server. Both raw diagnostic attempts are retained and excluded from the 12 inference sessions. The controller and old report remain untouched. Future host validation should inspect the actual client inventory and pass needed server environment explicitly before declaring a new experiment. No extra model run was purchased to turn this result green.

Zero recorded calls is established. Whether low tool salience, host behavior or another choice mechanism caused it is not established by these logs. Tool availability in this separate diagnostic does not prove model adoption. The repaired output's source sufficiency and natural-agent efficiency remain distinct results.

## Test results and remaining work

| Check | Result |
|---|---|
| Latest Windows focused suites/typecheck |103 tests / 8 files passed; `tsc --noEmit` passed |
| Linux source build and official bundle build |PASS |
| Full Linux `npm test`, four workers |8,627 passed; 3 timeouts; 401 skipped; exit1 |
| Same three timeout cases, immutable base and candidate, one worker |3/3 passed on each, unchanged 5-second defaults/assertions |
| Fresh extracted-bundle Webdom graph/MCP checks |PASS, 78 Tolk files, no parse issues |
| Frozen Codex sessions |12 completed, 0 retries; 28/30 each arm; 0 MCP calls |
| Historical evidence/process audit |145 original files unchanged; all recorded owned PIDs stopped; no Windows bridge helper remains |

The full suite is **not green**. The failures are Laravel mount-sync idempotency, Python nested-def receiver assignment and React HOC callees, each timing out at 5000 ms. They did not reproduce in selected isolated tests on either build. Load is a plausible explanation, not a proven root cause or a reproduced full upstream failure. Assertions/timeouts were not weakened. All Tolk suites and the relevant explore/path/budget/dedup suites passed in the full run; the full JSON/log and isolated receipts remain locally.

Original and new sanitized JSONL, answers, indices/readiness, grading and diagnostics are separate under `.tmp-tolk/codex-pilot/` and `.tmp-tolk/explore-repair/`. Commands were audited: no CodeGraph CLI/library/SQLite bypass, out-of-repository source read, network/project-script execution or tracked source change. All owned model, server, daemon, build and proxy processes stopped. The working installation, private index and agent configuration were preserved.

This does not establish upstream merge readiness. Medium/large and existing-language agent controls, human review and upstream's Sonnet-specific requirements remain open. Private MasterCTF was not rerun in this output-only repair; previous validation is in [the retained record](../tolk-validation.md).

## Reproduce the deterministic check

Extract the new archive into a fresh Linux directory, create a fresh clone at the Webdom pin, then run from this fork (explicit absolute paths):

```bash
export CODEGRAPH_DIR=.codegraph-explore-check
"$BUNDLE/node" --liftoff-only scripts/verify-tolk.mjs \
  --build "$BUNDLE/lib/dist" --project "$PROJECT" \
  --expect scripts/tolk-expectations/webdom.json --index --report /tmp/tolk-graph.json
"$BUNDLE/node" --liftoff-only scripts/verify-tolk-mcp.cjs \
  "$BUNDLE/bin/codegraph" \
  "[\"serve\",\"--mcp\",\"--no-watch\",\"--path\",\"$PROJECT\"]" \
  "$PROJECT" scripts/tolk-expectations/webdom-explore-scoped-mcp.json /tmp/tolk-mcp.json
```

For another Codex experiment, use the unchanged controller and the [original reproduction recipe](tolk-codex-pilot.md#reproduce), the new bundle, the frozen 037f protocol/key and a **new** output directory. Retain every attempt; never overwrite either pilot or silently change adoption policy. The [support instructions](../tolk-support.md) cover installation and rollback. Deploying this new artifact is a separate action.
