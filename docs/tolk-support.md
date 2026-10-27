# Tolk support in this fork

This fork adds `.tolk` discovery, declarations, source ranges, imports and conservative static calls to the existing TypeScript/WASM pipeline. It is based on upstream `69af19ace270f2e940444d514de6dde971df12df`, package version `1.6.2`. The package version alone does not identify this build.

The official parser comes from TON Language Server commit `342d87c26b5fab1e300015bf2831cafa59fda457`, with a small numeric-separator correction. Both upstream grammar packages identify as `0.4.5`; the standalone grammar at `beba5629dc4c9f81ff2dbde107c7b177505399df` lacks contract declarations. License and build provenance ship alongside the WASM. The tested Tolk compiler is `1.5.0`.

## Coverage

Functions, getters, receiver methods, parameters, signatures, return types, structs/fields, enums/members, aliases, constants, globals, imports and contract descriptors are indexed. Generic call syntax, annotations, assembler bodies, `self`, `mutate`, Unicode and CRLF are covered. Contract descriptors and file functions are siblings; receiver methods retain their explicit owner rather than being nested into the nearest struct.

Calls are restricted to the same file and directly imported eligible Tolk declarations. Imports `utils`, `utils.tolk`, `./utils` and `../utils` resolve relative to the importing file. Acton aliases use the nearest `Acton.toml` `[import-mappings]` table. Imported getters and message entrypoints remain private to their contract. Uncertain receivers, ambiguous names and missing external dependencies stay unresolved. Unrelated TypeScript and Tolk symbols do not connect by name.

Receiver inference is deliberately bounded to simple named types, typed parameters/locals, fields with a simple declared type, and unique factory return evidence (including the standard `Type.fromCell(...)` pattern). Generic/composite receiver substitution, dynamic callbacks and ambiguous return paths remain unresolved. `@stdlib/...` remains external: this implementation does not discover or import a toolchain standard library into the project graph. Acton mappings accept single-line basic/literal string entries; unsupported TOML forms remain unresolved. Mapping edits require an explicit `codegraph sync /absolute/project`; the source watcher watches `.tolk` edits but does not watch `Acton.toml`. Message passing, TVM behavior, generated ABI bridges to TypeScript and a Rust extractor are outside this implementation.

## Build and test

The verified source/bundle build used npm `11.19.1` on Linux (Windows focused checks used npm `11.13.0`), with the committed lockfile. Use Linux Node `24.22.1` in WSL, not `node.exe` from `/mnt/c`. Keep the checkout and test copies in the Linux filesystem.

```bash
node -p 'JSON.stringify({node:process.version,path:process.execPath,platform:process.platform,sqlite:!!require("node:sqlite").DatabaseSync})'
npm ci
npm run build
npx vitest run __tests__/tolk-extraction.test.ts __tests__/tolk-resolution.test.ts __tests__/tolk-sync.test.ts __tests__/tolk-verifier.test.ts __tests__/tolk-config-containment.test.ts
npm test
```

See the vendored grammar provenance for exact pinned compiler, generator, source patch and rebuild command. With Tree-sitter CLI 0.26.3 and Docker available, run:

```bash
bash scripts/build-tolk-grammar.sh
node scripts/add-lang/check-grammar.mjs src/extraction/wasm/tree-sitter-tolk.wasm /absolute/valid-sample.tolk
node scripts/add-lang/dump-ast.mjs src/extraction/wasm/tree-sitter-tolk.wasm /absolute/valid-sample.tolk --depth=8
```
 The rebuild must reproduce SHA-256 `4829ff208e5fa1c45ea2b546b608d331bd3fcc7671692edd6f3a250630f1cb8f`.

Validate an explicit build against source-derived named expectations:

```bash
CODEGRAPH_DIR=.codegraph-tolk node --liftoff-only scripts/verify-tolk.mjs \
  --build /absolute/fork/dist --project /absolute/test-copy \
  --expect /absolute/expectations.json --index --report /absolute/report.json
```

The verifier checks files, exact symbols, source/line information, import/call endpoints and forbidden edges; total node counts are insufficient. `--index` is opt-in. Keep private expectations and source out of Git. For a different build choose a different `CODEGRAPH_DIR` in every command and MCP process.

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
CODEGRAPH_DIR=.codegraph-tolk "$install_dir/bin/codegraph" node --path /absolute/project --file contracts/core/MasterCTF.tolk
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

For the Windows Codex app launching the WSL build, use `wsl.exe` and pass environment through Linux `env`:

```toml
[mcp_servers.codegraph]
enabled = true
command = "wsl.exe"
args = ["-d", "Ubuntu-24.04", "--", "env", "CODEGRAPH_DIR=.codegraph-tolk", "CODEGRAPH_MCP_TOOLS=explore,node", "CODEGRAPH_NO_UPDATE_CHECK=1", "CODEGRAPH_NO_DAEMON=1", "CODEGRAPH_QUERY_POOL_SIZE=0", "/home/ssobolev/.local/opt/codegraph-tolk/bin/codegraph", "serve", "--mcp", "--path", "/absolute/linux/project"]
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

The task's tests preserved the installed CLI, agent configuration and existing indices. A fresh index is required to gain Tolk coverage; extraction version is bumped. First build `.codegraph-tolk` alongside the original index and validate it. Then opt into the new absolute MCP command. No global replacement is required.

Before switching, save the active MCP configuration, exact executable path and version. In this checked environment the old WSL bundle is `/home/ssobolev/.codegraph/bundles/linux-x64-1.6.2/bin/codegraph`, reached by the npm shim. Private configuration snapshots and hashes are retained locally, not published. To roll back, restore the previous MCP entry and its previous `CODEGRAPH_DIR` value (unset if absent), then restart the client. The old executable and index remain available.

Keep this work on `codex/tolk-support`. To update: fetch upstream, rebase the branch onto the selected full upstream SHA, resolve language-registry and extraction-version conflicts, rebuild the pinned grammar if its inputs changed, and rerun focused/full tests, real-corpus expectations and extracted-bundle/MCP checks. Do not infer compatibility from matching package versions.
