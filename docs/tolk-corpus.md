# Repeatable Tolk corpus checks

Keep corpus sources, build artifacts and results outside the CodeGraph checkout,
on the Linux filesystem when using WSL. Do not commit private contracts, answers,
credentials or raw MCP responses to this repository.

```text
codegraph-corpus/
  projects/       # working source copies, one repository per directory
  incoming/       # additional repositories awaiting a source-only expectation review
  snapshots/      # immutable inputs and source manifests for comparisons
  builds/         # source checkouts and separately extracted release archives
  runs/           # one new directory per iteration; never overwrite an older run
  corpus.json     # origin, full commit or snapshot ID, compiler version and inventory
```

For public repositories, record the actual branch and full SHA before indexing.
For example, `ton-blockchain/acton-contracts` uses `master` in the checked
snapshot, while `webdom-market/webdom-contracts` uses `main`. Check remote refs
when updating; do not silently substitute an experimental branch. Copy private
projects using an explicit source allowlist and the import configuration needed
by those sources. Keep deployment data, wallets, credentials, existing indexes
and agent settings out of the copy.

## Check, improve, check again

1. Freeze the source snapshot, Tolk/compiler declaration, expected files,
   declarations and positive/negative call targets **before** querying the graph.
   Identify any unknown compiler version rather than guessing it.
2. Record the CodeGraph commit, Node version, WASM hash, build/archive hash and
   expectation/protocol hashes. Package version alone does not identify a build.
3. Build and run focused tests, then replay deterministic CLI/MCP queries. For a
   flow question, inspect the first response against the independent source key:
   conditions, data values, helper bodies, imports and source locations matter.
   Nonempty output or a matching call count does not establish sufficiency.
4. Fix a demonstrated omission with a synthetic regression test. Preserve the
   failed response and create a new result directory for the repaired build.
   Keep output budgets, explicit line focus, freshness and negative call checks.
5. Once deterministic checks pass, run the full relevant tests and validate a
   newly extracted bundle outside the checkout, including a real MCP client.
6. Only then run the frozen agent comparison. Keep the same questions, sources,
   model/effort, repeat count, arm order and tools. Store raw outputs as well as
   aggregates. Do not tune questions or discard failures after seeing answers.

Existing source expectations are in `scripts/tolk-expectations/`. Reuse one only
after checking its provenance and source assertions against the selected SHA.
Adding a repository does not make an old oracle valid for it.

## Deterministic verification

Use explicit absolute paths and a new project copy/index for each build:

```bash
fork=/absolute/path/to/codegraph
bundle=/absolute/path/to/extracted/codegraph-linux-x64
project=/absolute/path/to/run/project-copy
report=/absolute/path/to/run/graph.json

CODEGRAPH_DIR=.codegraph-candidate "$bundle/node" --liftoff-only \
  "$fork/scripts/verify-tolk.mjs" \
  --build "$bundle/lib/dist" --project "$project" \
  --expect "$fork/scripts/tolk-expectations/webdom.json" \
  --index --report "$report"
```

The example expectation requires its recorded Webdom snapshot. Use the matching
source, or prepare a new independent expectation file. `success` must be true;
also inspect parse diagnostics, unresolved references and negative checks.
Missing standard-library or external dependencies must remain explicit.

For the same index, exercise initialize, tools/list and concrete tool responses:

```bash
CODEGRAPH_DIR=.codegraph-candidate "$bundle/node" --liftoff-only \
  "$fork/scripts/verify-tolk-mcp.cjs" "$bundle/bin/codegraph" \
  "[\"serve\",\"--mcp\",\"--no-watch\",\"--path\",\"$project\"]" \
  "$project" "$fork/scripts/tolk-expectations/webdom-mcp.json" \
  /absolute/path/to/run/mcp.json
```

Keep each response beside its report. Track and stop only the processes started
by that test. Do not run `scripts/add-lang/bench.sh` as a smoke test: it removes a
corpus index and can start paid agent work.

## Agent comparison records

See [the A/B method](benchmarks/tolk-agent-ab.md) and
[the Codex pilot](benchmarks/tolk-codex-pilot.md). An explicitly required first
`codegraph_explore` tests sufficiency with adoption held constant; it does not
measure whether an unprompted agent would choose the tool. Record this distinction.

Report elapsed time from client launch through exit, with preparation/indexing
reported separately. Record native input, cached input and output token counts,
tool calls, file reads/searches, the action following each explore, answer
correctness, timeouts and protocol violations. Cached input is a subset of input;
reasoning tokens may be a subset of output. Do not add subsets twice or infer a
dollar saving from subscription usage. Show per-case values, medians and ranges.

Use isolated per-process configuration with only the intended server enabled.
Preserve exact existing configuration before testing and verify it afterward.
Never publish or retain credential copies in corpus artifacts. Authentication or
environment changes between cohorts are confounders and belong in the report.
Keep the baseline archive, protocol, inputs and raw results unchanged, even when
a new build is slower. A failed acceptance target remains a failed result.

For grammar rebuilds, supported syntax, bundle construction, MCP setup and
rollback, see [Tolk support](tolk-support.md).
