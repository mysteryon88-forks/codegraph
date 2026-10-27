# Tolk agent A/B: proposed test protocol

**Status: designed, not run.** No model sessions or paid judging were launched to prepare this document. Static graph/CLI/MCP checks in [the validation record](../tolk-validation.md) are separate evidence. This protocol measures whether an agent obtains correct answers more efficiently; it does not establish that every extracted edge is correct.

## Experiment and scope

The pilot uses three public Webdom tasks. For each task, run a fresh Claude session twice in each arm:

- **A / without:** ordinary source tools, empty MCP configuration, no CodeGraph index data.
- **B / with:** the same task/model/source profile, with the tested Tolk build exposed through MCP.

Use `--model sonnet --effort high` in every session, as [upstream requires](../AGENTS.md). Record the actual model identifier returned, not just the moving `sonnet` alias. Do not tell B to use a particular tool or provide the expected call chain. Read/Grep remain available in B.

| Pack | Tasks | Comparison | Independent sessions |
|---|---|---|---:|
| Pilot | W1–W3, Webdom | without vs new | 3 × 2 arms × 2 repeats = **12** |
| Medium extension | M1–M3, Acton | without vs new | **12** |
| Existing-language control | C1–C3, Express | baseline CodeGraph-on vs new CodeGraph-on | **12** |
| All specified packs | 9 tasks | comparisons above | **36** |

The control isolates regressions from the shared explore change. It is not another without/with comparison. A genuinely large indexed corpus and three source-derived questions remain a separate missing upstream gate; do not relabel these packs or pad a repository. Two repeats are an exploratory minimum, not statistical proof.

### Frozen inputs

| Input | Identity |
|---|---|
| New build and harness | CodeGraph `79cb5f4d99d37b97bbc5b66202bcbe14d8b5a711` |
| Baseline control build | Upstream `69af19ace270f2e940444d514de6dde971df12df`, built separately |
| New Linux-x64 archive | SHA-256 `dab7de527ee8f967cb645b8023bd400daed8d6c355bc33a817463f969952307f` |
| Webdom | `webdom-market/webdom-contracts` at `187e0589f437fe398e3385f4a434e9755d1b4d87` |
| Acton | `ton-blockchain/acton` at `b8407f0e628860311d391eff85d003ec9c2cfb2c` |
| Express | `expressjs/express` v5.1.0, commit `cd7d4397c398a3f3ecadeaf9ef6ac1377bd414c4` (not the annotated-tag object) |

The previous deterministic indices had 203 files for Webdom and 2,936 for Acton, including 78 and 178 Tolk files respectively. Measure fresh counts/tier before running. Express has not been indexed for this protocol. For Acton, apply the exact `provenance.indexConfig` from [acton.json](../../scripts/tolk-expectations/acton.json) to every task copy: its three deliberate compilation-error fixtures are excluded before indexing. Keep all other includes/excludes equal between arms. Pin compiler evidence and grammar hash from the validation record; do not infer build identity from package version 1.6.2.

## Task prompts

Prepend the following **identical** instruction to every task. Use the English text verbatim in both arms; task IDs and evaluator notes are not part of the prompt.

> Investigate only the source in the current repository. Do not edit files, run project scripts, access the network, or read other repositories, evaluator material, benchmark logs, graph databases or index internals. Do not invoke CodeGraph through a CLI, library or SQLite; use only tools exposed to this session. Explain the relevant static path in at most eight sentences, cite repository-relative file:line locations for your claims, distinguish local calls from external runtime boundaries, and state uncertainty instead of inventing a target.

**W1 — NFT notification**
> In `contracts/marketplace/contract.tolk`, trace how an internal NFT ownership-assignment notification reaches its gas check. Identify the entrypoint, handler, helper and relevant local import. Keep other contracts' handlers separate.

**W2 — Domain swap**
> In `contracts/domain_swap/contract.tolk`, where does processing the right side's final payment reach deal completion? Identify the local completion helper and how it is made available. Distinguish internal-message processing from the external-message path and unrelated contracts.

**W3 — Sale reserve**
> In `contracts/fix_price_sales/ton_simple_sale/contract.tolk`, trace the external-message path to reserve calculation. Identify where the storage reserve and per-iteration auto-renew reserve come from, including their declaring files. Do not infer a call into another contract with the same handler name.

**M1 — Recursive deployment**
> In `apps/localton/load-test/contracts/RecursiveDeployer.tolk`, trace the internal Expand message to child deployment. Identify the expansion and deployment helpers, and the storage read/write methods they use, with the correct receiver owner and files.

**M2 — Counter storage**
> In `src/commands/new/templates/counter/contracts/Counter.tolk`, trace an internal counter update through loading and saving storage. Identify the receiver type, method declarations and import. Explain which same-named contract handlers or storage methods do not belong to this path.

**M3 — Jetton transfer amount**
> In `src/commands/new/templates/jetton/contracts/JettonMinter.tolk`, trace transfer-amount validation to the minimum-amount calculation. Identify the helper declarations and relevant import. Keep the wallet entrypoint separate from this minter path.

**C1 — Express request dispatch**
> Trace the callable application returned by `createApplication` in `lib/express.js` into request dispatch. Explain the request handler, final callback selection and prototype setup, and identify where execution leaves this repository's implementation for the router dependency.

**C2 — Express mounting**
> Explain how `app.use('/child', childApp)` is registered in `lib/application.js`, how it differs from ordinary middleware registration, and how request/response prototypes and errors are handled when the child finishes.

**C3 — Express listening**
> Trace `app.listen(port, callback)` in `lib/application.js`: server construction, callback wrapping, error handling, argument forwarding and return value. Distinguish Express code from the Node HTTP runtime boundary.

The [evaluator key](tolk-agent-ab-answers.md) contains five source facts per task. Freeze prompt/key hashes before execution. Keep the key, this driver checkout and all logs outside the task repository; never paste the key or graph output into either arm's context.

## Preparation: no model calls

Use Linux Node 24.22.1 and a Linux Claude CLI in WSL/ext4. Use paths without whitespace, quotes or backslashes: the existing harness embeds paths in JSON and hook command text. No global installation/configuration change is required.

1. Make a pinned Linux driver checkout at the build/harness commit above. Build the baseline in another checkout with `npm ci && npm run build` under the same Node version. Use the verified new bundle. Record absolute executables, full SHAs, versions and hashes of the harness/parser/hook files. An installed package reporting 1.6.2 is not a baseline pin.
2. Prepare unindexed pinned source caches for the three repositories. No private MasterCTF source is used. For each invocation, make a separate local clone with `git clone --no-hardlinks "$CACHE" "$TASK"`, then `git -C "$TASK" checkout --detach "$CORPUS_SHA"`. Do not clone a previous agent task directory. Preserve identical tracked source and controller-supplied config; hash and record them before and after each session.
3. Put task copies, output and comparison directories under a dedicated system-TEMP root. They must be siblings, not nested agent workspaces. Do not copy `.codegraph`, answers, earlier transcripts or user configuration into a task. Snapshot any controller-generated changes before agent execution; tracked source changes during a session invalidate it.
4. Unset ambient `CODEGRAPH_DIR`; this harness checks for a literal `$TASK/.codegraph`. In A create that **empty directory only** to satisfy the check, and verify it contains no data. In B/control initialize a genuinely new index with the selected absolute build. Record status and graph counts. Keep both arms' source/config profile equal.
5. Verify `claude --version`, installed help/flag compatibility, login availability and the approved billing/limit arrangement without a model-request probe. `run-all.sh` needs `jq`, `node`, `claude` and its `no-cli-shim.sh` self-check. A missing prerequisite stops execution rather than substituting another model/host.

For the source-built baseline, create a controller-side executable named `codegraph` that execs the absolute Linux Node with `--liftoff-only /absolute/baseline/dist/bin/codegraph.js "$@"`. Use the bundle's `bin/codegraph` for the new build. Keep wrappers outside agent workspaces; use absolute `CG_BIN`, never the installed CodeGraph from PATH. The name also keeps invocation attempts within the existing CLI-block hook's matching rules.

## One invocation and counterbalanced order

For repeat 1 run A then B; for repeat 2 run B then A. Apply the same order to baseline/new control arms. Every invocation has a fresh source copy, fresh single-turn Claude context and **unique output directory**. Reserve `OUT` once with `mkdir "$OUT"` (after creating its parent); failure means stop, not reuse it. Then create preparation logs there. Do not use `||` multi-turn prompts or `--resume`; resumed turns are not independent repeats.

Set these equally for both arms; do not inherit a global no-daemon setting into the warm benchmark:

```bash
export MODEL=sonnet EFFORT=high
export CODEGRAPH_NO_PROMPT_HOOK=1 CODEGRAPH_NO_UPDATE_CHECK=1
export CODEGRAPH_MCP_TOOLS=explore,node CODEGRAPH_QUERY_POOL_SIZE=0
export CODEGRAPH_WASM_RELAUNCHED=1 CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS=1800000
unset CODEGRAPH_DIR CODEGRAPH_NO_DAEMON
```

Before each B/control session, pre-warm **only its new task directory** with the selected build's `serve --mcp --path "$TASK"`, stdin from `/dev/null`, stdout/stderr in that invocation's output directory. Record launcher PID immediately, wait at most15seconds for `.codegraph/daemon.pid` and `.codegraph/daemon.sock`, save the lock's complete identity and verify that recorded PID is alive. Use a short TEMP path so socket fallback is unnecessary. This preparation and indexing are excluded from agent latency and reported separately. No CodeGraph daemon runs for A.

Register cleanup before pre-warming. On every success/failure/interruption, compare the current daemon lock with the recorded identity and call that build's `stopDaemonAt(realpath(TASK), {preserveUnverified:true})` from `dist/mcp/daemon-registry.js`. Also stop/reap the recorded pre-warm launcher if still alive and still associated with this task. Log both exits; a changed identity, unverified/still-running outcome or forced stop is a lifecycle failure, not permission to kill a different process. Never use broad `pkill` or the shared-checkout-changing `ab-new-vs-baseline.sh`. Do not run a paid session without this bounded owned-process cleanup.

After those preconditions, the existing invocation is:

```bash
# TASK, PROMPT, DRIVER, CG_BIN and OUT are controller-selected absolute values.
# OUT must be new, e.g. $WORK/runs/W1/r1/without or .../with.
set -euo pipefail
test -d "$OUT"  # newly reserved by the controller before pre-warming
test ! -e "$OUT/run-headless-with.jsonl"
test ! -e "$OUT/run-headless-without.jsonl"
CG_ARMS=without CG_BIN="$CG_BIN" AGENT_EVAL_OUT="$OUT" \
  bash "$DRIVER/scripts/agent-eval/run-all.sh" "$TASK" "$PROMPT" headless
```

Use `CG_ARMS=with` for B **and both control builds**. `RUNS=2` does nothing in `run-all.sh`: repeat invocations explicitly. The script prints a child exit but does not reliably propagate every Claude/parser failure; inspect the complete result event, stderr and transcript before marking a run valid. Do not treat the harness shell exit alone as acceptance. Preserve the full original output folder, including settings, MCP config and hooks.

After each completed run, copy its single-turn transcript into a separate comparison directory, retaining originals. Use unique numbered labels:

```bash
set -euo pipefail
# CMP/CTRL_CMP are experiment-specific directories reserved once, outside tasks.
test ! -e "$CMP/run-without-1.jsonl"
test ! -e "$CMP/run-with-1.jsonl"
cp "$WITHOUT_OUT/run-headless-without.jsonl" "$CMP/run-without-1.jsonl"
cp "$WITH_OUT/run-headless-with.jsonl" "$CMP/run-with-1.jsonl"
# Repeat2 writes -2, never overwriting -1.
node "$DRIVER/scripts/agent-eval/compare-arms.mjs" "$CMP" without with

# Controls: both originals are run-headless-with.jsonl in DISTINCT OUT folders.
test ! -e "$CTRL_CMP/run-baseline-1.jsonl"
test ! -e "$CTRL_CMP/run-new-1.jsonl"
cp "$BASE_OUT/run-headless-with.jsonl" "$CTRL_CMP/run-baseline-1.jsonl"
cp "$NEW_OUT/run-headless-with.jsonl" "$CTRL_CMP/run-new-1.jsonl"
node "$DRIVER/scripts/agent-eval/compare-arms.mjs" "$CTRL_CMP" baseline new
```

Keep a receipt per invocation: task/repeat/arm, source/build/config/prompt/key hashes, exact argv/environment choices, actual model, tool availability, index tier, owned PIDs/exits, preparation time, transcript paths and completion/error/budget status. Stop before reusing an output path or running beyond the approved session/budget allocation.

## Validity, scoring and decision

First grade anonymized **final answers**, without arm/timing labels, against the evaluator key. Use a human independent of the answering session; no paid LLM judge is needed. Each answer scores0–5. Any fabricated target, wrong contract/receiver or invented cross-language/message-delivery edge is a critical failure even if other facts are correct. B must score5/5 without critical errors on every primary task. Report A failures too; never discard them to improve a mean.

Audit complete transcripts for CLI/library/SQLite/index reads, external MCP/network/evaluator access, source edits, different actual model/tool setup and failed startup/auth. Any such contamination or infrastructure failure makes a run **invalid**, not a zero-quality answer. A with-arm that had working tools but did not use CodeGraph records an adoption failure; do not retry it merely to get a nicer result. All invalid attempts still consume the approved budget.

Record elapsed agent wall time, tool calls, native Read/Grep, equivalent Bash source reads/searches (`cat`, `rg`, scripts), explore/node counts, errors, reported cost/billing mode and usage. Audit shell equivalents: native `Grep=0` does not prove no search. Report the three [feedback metrics](agent-eval-feedback-metrics.md): end-of-session context occupancy, action after explore, and allocation efficiency. Single-turn occupancy here does not measure a benefit on subsequent turns; without-arm allocation is N/A.

Use medians **and ranges** per task/arm. Compare speed only for paired correct completions; keep completion/error rates and censored timeouts/budget exhaustion alongside them. Do not report an unfinished answer as a fast result or a speed ratio against an uncompleted baseline. Count actual CodeGraph calls, not merely MCP startup's pending tool list.

Exploratory success requires all B correctness checks, approximately zero native/equivalent Read/Grep, explore within1call for <500 indexed files or2calls for <5,000, and at least10% lower paired time in both repeats. Node calls still count in total tools. Opposite signs/order sensitivity, overlap or fewer valid pairs are **inconclusive**. Control new-build quality must not fall, and median time/total tools must stay within110% of baseline per task; this is a noise screen, not a significance test. A result outside these bounds is reported, not corrected by changing questions/rubrics after seeing answers. More repeats require separately approved budget.

## Budget and result status

`run-all.sh` at the pinned commit specifies `--max-budget-usd 4` per Claude invocation. Arithmetic sums are 48 USD for the 12-session pilot and 144 USD for all 36 sessions. These are configured ceiling sums, **not a price estimate, aggregate billing guarantee or spending authorization**. Login/subscription/API mode and the installed CLI's handling of this limit must be established first; the harness has no shared monetary meter. Agree a total budget and session allocation separately. Before each launch reserve its full configured ceiling against the approved remainder; if actual spend is unavailable, conservatively count the reservation as spent. Stop if the cap cannot be verified, count spent invalid runs, and do not auto-retry.

Until execution, fill results as **NOT RUN**, never zero or PASS. Record build/index/grammar time separately from interactive retrieval. Preserve prompts, frozen key, source pins, complete transcripts, blind scores and comparison tables. No token-saving/agent-speed claim or upstream merge gate is closed by writing this protocol.
