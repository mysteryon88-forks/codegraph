# Tolk support in this fork

This fork adds `.tolk` discovery, declarations, source ranges, imports and conservative static calls to the existing TypeScript/WASM pipeline. The original Tolk base was upstream commit `69af19ace270f2e940444d514de6dde971df12df` (package version `1.6.2`); upstream `main` at `01e0ac3aa7419a7ab75583963e8a95359f3af1d3` was merged later in `3144ee202a21edab0f0011c6a91070477c9dbc41`. Benchmark results remain tied to the commit used for each run; that merge does not change their build identity. The package version alone does not identify this build.

The official parser comes from Acton commit `b8407f0e628860311d391eff85d003ec9c2cfb2c`, subtree `crates/tree-sitter-tolk`, without local grammar patches. Its package still identifies as `0.4.5`, although its syntax and AST differ from the standalone and Language Server copies. License, full source pin, tool versions and checksum ship alongside the WASM. The tested Tolk compiler is `1.5.0`.

## Coverage

Functions, getters, receiver methods, parameters, signatures, return types, structs/fields, enums/members, aliases, constants, globals, imports and contract descriptors are indexed. Generic call syntax, annotations, assembler bodies, `self`, `mutate`, numeric separators, trailing commas in tensor/tuple types, Unicode and CRLF are covered. Contract descriptors and file functions are siblings; receiver methods retain their explicit owner rather than being nested into the nearest struct. Local declarations use the pinned grammar's AST, preserving initializer scope, explicit types, shadowing and conservative handling of destructuring/reassignment.

Calls are restricted to the same file and directly imported eligible Tolk declarations. Imports `utils`, `utils.tolk`, `./utils` and `../utils` resolve relative to the importing file. Acton aliases use the nearest `Acton.toml` `[import-mappings]` table. Imported getters and message entrypoints remain private to their contract. Uncertain receivers, ambiguous names and missing external dependencies stay unresolved. Unrelated TypeScript and Tolk symbols do not connect by name.

Receiver inference is deliberately bounded to simple named types, typed parameters/locals, fields with a simple declared type, and unique factory return evidence (including the standard `Type.fromCell(...)` pattern). Generic/composite receiver substitution, dynamic callbacks and ambiguous return paths remain unresolved. `@stdlib/...` remains external: this implementation does not discover or import a toolchain standard library into the project graph. Acton mappings accept single-line basic/literal string entries; unsupported TOML forms remain unresolved. Mapping edits require an explicit `codegraph sync /absolute/project`; the source watcher watches `.tolk` edits but does not watch `Acton.toml`. Message passing, TVM behavior, generated ABI bridges to TypeScript and a Rust extractor are outside this implementation.

Simple named type arms of `match(localOrParameter)` narrow that lexical binding only within the arm. Assignments and explicit `mutate` arguments discard stale evidence. After a method call on a narrowed binding, later references require a unique visible target with the same narrowed receiver type; an unknown method cannot silently preserve a type that `mutate self` may have widened. These per-reference requirements survive sync and inferred returns, are deduplicated, and stop at 16 distinct methods or 1 KiB of encoded proof. Unsupported patterns, globals, generic `loadAny<T>()` return substitution and exhausted bounds remain unresolved.

When an explore query explicitly names only Tolk files, its source and flow stay within the selected declarations and their outgoing dependencies (three hops, at most 200 nodes). Relevant imports and receiver types remain visible; unrelated users of shared helpers do not enter through incoming calls. For file-pinned Tolk queries, explore can favor already-scoped type declarations over weak generated-file matches while honoring explicit file requests and existing output budgets. Source keeps the existing file and byte budgets, line pins and session deduplication. The caller summary is explicitly limited to that dependency scope, so it is not a complete impact report. Unpinned and mixed-language queries retain ordinary explore behavior. The [Codex comparison](benchmarks/tolk-codex-explore-comparison.md) records source sufficiency separately from whether the agent chooses the tool.

## Build and test

Use Linux Node `24.22.1` in WSL, not `node.exe` from `/mnt/c`, with the committed lockfile. Keep the checkout, grammar build and test copies in the Linux filesystem. A mounted Windows checkout can have file ownership that prevents Linux `cp` from replacing its WASM; the verified rebuild runs on Linux ext4 and does not require changing mount ownership or starting Docker globally.

```bash
node -p 'JSON.stringify({node:process.version,path:process.execPath,platform:process.platform,sqlite:!!require("node:sqlite").DatabaseSync})'
npm ci
npm run clean
npm run build
npx vitest run __tests__/tolk-extraction.test.ts __tests__/tolk-resolution.test.ts __tests__/tolk-call-proof.test.ts __tests__/tolk-sync.test.ts __tests__/tolk-verifier.test.ts __tests__/tolk-config-containment.test.ts __tests__/tolk-explore.test.ts
npm test
```

See the vendored grammar provenance for the pinned compiler, generator and rebuild command. With Tree-sitter CLI 0.26.3 and Docker available, run:

```bash
bash scripts/build-tolk-grammar.sh
node scripts/add-lang/check-grammar.mjs src/extraction/wasm/tree-sitter-tolk.wasm /absolute/valid-sample.tolk
node scripts/add-lang/dump-ast.mjs src/extraction/wasm/tree-sitter-tolk.wasm /absolute/valid-sample.tolk --depth=8
```
The rebuild must reproduce SHA-256 `663a425723b0b71bcb990136149b9cb7be83fee80825fe321b15583ef6ebc921`. With an existing task-local Emscripten 4.0.16 on the command's PATH, `TOLK_NATIVE_EMCC=1 bash scripts/build-tolk-grammar.sh` runs the same two-build/hash verification without Docker. Neither route installs global tools.

Validate an explicit build against source-derived named expectations:

```bash
CODEGRAPH_DIR=.codegraph-tolk node --liftoff-only scripts/verify-tolk.mjs \
  --build /absolute/fork/dist --project /absolute/test-copy \
  --expect /absolute/expectations.json --index --report /absolute/report.json
```

The verifier checks files, exact symbols, source/line information, import/call endpoints and forbidden edges; total node counts are insufficient. Any indexed Tolk parse diagnostic makes `success` false and the process exit nonzero, while retaining recovered symbols and `parseIssues` in the report. A malformed sibling cannot be hidden by a valid function. `--index` is opt-in. Keep private expectations and source out of Git. For a different build choose a different `CODEGRAPH_DIR` in every command and MCP process.

For agent-efficiency checks, see the [Tolk A/B protocol](benchmarks/tolk-agent-ab.md), its separate evaluator key and the [completed Codex subscription pilot](benchmarks/tolk-codex-pilot.md). The Codex pilot did not demonstrate an efficiency improvement; the original Sonnet, medium/control and large-corpus agent gates remain open.

For the two public snapshots used during acceptance:

```bash
mkdir -p /tmp/codegraph-tolk-public
cd /tmp/codegraph-tolk-public
git clone https://github.com/ton-org/docs-examples.git
git -C docs-examples checkout 9db211db732fd2288c4aec2d99b7896f40cd2cba
git clone https://github.com/ton-blockchain/acton-contracts.git
git -C acton-contracts checkout d721c3179696b453a9490fcfd2f30770f8c234b4
```

Use `docs-examples/guidebook/first-smart-contract/Example` with this fork's `scripts/tolk-expectations/counter.json`, or `acton-contracts/jetton-v2.1` with `jetton.json`. These expectation files record the provenance and specific source-derived assertions. They are required-file subsets: generated or test files may also be indexed. The report separately lists all discovered, scan-eligible and indexed Tolk files.

The expanded acceptance also checks the complete `acton-contracts` snapshot, Webdom, Acton, TON and TG Wallet. Their full pins, predeclared exclusions and compiler evidence are in the corresponding `scripts/tolk-expectations/*.json` and [validation report](tolk-validation.md). For example:

```bash
git clone https://github.com/webdom-market/webdom-contracts.git
git -C webdom-contracts checkout 187e0589f437fe398e3385f4a434e9755d1b4d87
mkdir -p /tmp/codegraph-tolk-reports
CODEGRAPH_DIR=.codegraph-tolk-webdom node --liftoff-only /absolute/fork/scripts/verify-tolk.mjs \
  --build /absolute/fork/dist --project "$PWD/webdom-contracts" \
  --expect /absolute/fork/scripts/tolk-expectations/webdom.json --index \
  --report /tmp/codegraph-tolk-reports/webdom.json
```

For Acton and TON, write the expectation file's `provenance.indexConfig` as `codegraph.json` in the disposable clone **before** indexing: these exclude deliberately invalid compiler fixtures identified from source. Keep their exclusion count in the report. TG Wallet intentionally retains a missing generic `loadAny<T>()`-dependent call in its oracle; its strict verifier currently exits nonzero for that unsupported case. Do not remove the expectation to obtain a pass.

## Isolated bundle

```bash
bash scripts/build-bundle.sh linux-x64 v24.22.1
sha256sum release/codegraph-linux-x64.tar.gz
```

Extract the archive into a new directory outside the checkout. The bundled Node runtime and grammar make it independent of system Node and development files. Do not use root `npm pack`, `npm link`, or `local-install.sh` for this acceptance path.

```bash
install_dir="$HOME/.local/opt/codegraph-tolk"
mkdir -p "$install_dir"
tar -xzf /absolute/codegraph-linux-x64.tar.gz -C "$install_dir" --strip-components=1
"$install_dir/bin/codegraph" --version
CODEGRAPH_DIR=.codegraph-tolk CODEGRAPH_NO_PROMPT_HOOK=1 "$install_dir/bin/codegraph" init /absolute/project --yes
CODEGRAPH_DIR=.codegraph-tolk "$install_dir/bin/codegraph" files --path /absolute/project --pattern '**/*.tolk' --json
CODEGRAPH_DIR=.codegraph-tolk "$install_dir/bin/codegraph" node --path /absolute/project --file contracts/first_contract.tolk
```

Use a fresh install directory if that path already contains another build. The archive digest is distributed in the adjacent checksum file. A version response alone is not acceptance: repeat the named graph verifier against `--build "$install_dir/lib/dist"` using the bundle's `node`.

## MCP connection

For Codex running inside Linux/WSL, put only this server override in the trusted project's `.codex/config.toml`, replacing absolute paths:

```toml
[mcp_servers.codegraph]
enabled = true
command = "/absolute/codegraph-tolk/bin/codegraph"
args = ["serve", "--mcp", "--path", "/absolute/project"]
env = { CODEGRAPH_DIR = ".codegraph-tolk", CODEGRAPH_MCP_TOOLS = "explore,node", CODEGRAPH_NO_UPDATE_CHECK = "1", CODEGRAPH_NO_DAEMON = "1", CODEGRAPH_QUERY_POOL_SIZE = "0" }
```

For the Windows Codex app launching the WSL build, use `wsl.exe` and pass environment through Linux `env`. Replace `YOUR_WSL_DISTRO`, `YOUR_LINUX_USER` and the project path with values from your own WSL installation before saving; the TOML strings are literal:

```toml
[mcp_servers.codegraph]
enabled = true
command = "wsl.exe"
args = ["-d", "YOUR_WSL_DISTRO", "--", "env", "CODEGRAPH_DIR=.codegraph-tolk", "CODEGRAPH_MCP_TOOLS=explore,node", "CODEGRAPH_NO_UPDATE_CHECK=1", "CODEGRAPH_NO_DAEMON=1", "CODEGRAPH_QUERY_POOL_SIZE=0", "/home/YOUR_LINUX_USER/.local/opt/codegraph-tolk/bin/codegraph", "serve", "--mcp", "--path", "/home/YOUR_LINUX_USER/path/to/project"]
```

The selected upstream exposes only `codegraph_explore` by default; `CODEGRAPH_MCP_TOOLS=explore,node` also lists `codegraph_node`. No app connector or unrelated MCP server is needed. Restart the MCP client/chat after changing its configuration. Keep the index path identical to the one used by `init`. The validation report records a real JSON-RPC client checking initialize, tools/list, explore, file/symbol node reads and clean process shutdown via SIGTERM.

To repeat the real MCP protocol check, run the included client inside Linux/WSL against the selected bundle and an already indexed public test copy:

```bash
bundle=/absolute/codegraph-tolk
project=/tmp/codegraph-tolk-public/docs-examples/guidebook/first-smart-contract/Example
mkdir -p /tmp/codegraph-tolk-reports
CODEGRAPH_DIR=.codegraph-tolk CODEGRAPH_QUERY_POOL_SIZE=0 \
  "$bundle/node" /absolute/fork/scripts/verify-tolk-mcp.cjs \
  "$bundle/bin/codegraph" \
  '["serve","--mcp","--no-watch","--path","/tmp/codegraph-tolk-public/docs-examples/guidebook/first-smart-contract/Example"]' \
  "$project" /absolute/fork/scripts/tolk-expectations/counter-mcp.json \
  /tmp/codegraph-tolk-reports/counter-mcp.json
```

The client explicitly disables network update checks, daemon sharing and prompt hooks for isolation, requests `explore,node`, verifies two node reads and three flow queries, then requests graceful SIGTERM and requires exit code 0. It tracks and stops its own process group on failure. Reports include returned source in adjacent files: use a private temporary directory for private projects. A seeded wrong expectation was checked to fail and clean up its process. The default shared-daemon path was not used for acceptance; Online EOF-only probes sometimes hung on both baseline and new builds. With update checking disabled, three additional Counter runs exited cleanly; the exact native TLS teardown cause is unproven. This client explicitly tests the supported signal handler with the same offline setting. Baseline process-lifecycle failures are recorded in [the validation report](tolk-validation.md).

## Migration, rollback and updates

The task's tests preserved the installed CLI, agent configuration and existing indices. A fresh index is required to gain Tolk coverage. Extraction version 29 covers the original language addition; this grammar/bugfix revision does not increment it under upstream's pure-bugfix policy. An index made by the earlier fork can therefore report the same extraction version while still containing old parse diagnostics or extraction. Use a new `CODEGRAPH_DIR` and a fresh index when switching grammar builds; repeating `indexAll` against an existing directory is not an independent rebuild. Validate the new index before opting into the new absolute MCP command. No global replacement is required.

Before switching, record the active MCP entry, exact launcher path and version, and index directory (`CODEGRAPH_DIR`). Keep a private copy of the old configuration outside the repository. To roll back, restore the saved MCP entry and prior `CODEGRAPH_DIR`, then restart the client. Keep the old launcher and index directory until the new build has been validated.

To update, fetch upstream and rebase the working branch onto the selected full upstream SHA. Resolve language-registry and extraction-version conflicts, rebuild the pinned grammar if its inputs changed, and rerun focused/full tests, real-corpus expectations and extracted-bundle/MCP checks. Do not infer compatibility from matching package versions.
