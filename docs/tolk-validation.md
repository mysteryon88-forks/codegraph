# Tolk validation record

Validation date: 2026-10-27. Tests used isolated project copies and indices; the installed CLI, original project indices and agent configuration were preserved. No private source, private expectation body or raw private graph report is committed.

## Identity and environment

- Starting upstream: `69af19ace270f2e940444d514de6dde971df12df`, package `1.6.2`; no Tolk registration was present. Both before/after arms use this exact base.
- Windows x64: Node `v24.22.1`, Python 3.12. Linux: real WSL2 Ubuntu 24.04, x64, `/usr/bin/node` `v24.22.1`, built-in `node:sqlite` available (SQLite 3.53.4). Test projects and build live under `/tmp/codegraph-tolk-20261027`, in the Linux filesystem.
- Existing WSL executable discovered here: `/home/ssobolev/.codegraph/bundles/linux-x64-1.6.2/bin/codegraph`; Windows/npm shims were preserved. The initially reported historical 1.6.0 installation was not found, so it is not claimed as the tested baseline or rollback target.
- Grammar origin, MIT license, patch, pinned generator/compiler and SHA-256 are recorded in [grammar provenance](../src/extraction/wasm/tree-sitter-tolk.PROVENANCE.md). Shipped grammar hash: `4829ff208e5fa1c45ea2b546b608d331bd3fcc7671692edd6f3a250630f1cb8f`.

## Independent source expectations and corpora

Named declarations, line/source assertions, positive call/import endpoints and forbidden targets were written from source before querying the changed graph. Public expectations and MCP queries are in [scripts/tolk-expectations](../scripts/tolk-expectations); private expectations were kept only in system TEMP during execution. The private snapshot was not compiled anew; its compiler identity comes from the local lockfile and existing ABI compiler metadata. Both public contract examples were compiled with Tolk 1.5.0 separately from graph extraction.

| Corpus | Exact origin | Compiler evidence | Raw .tolk | Indexed .tolk | Excluded | Parse issues |
|---|---|---|---:|---:|---:|---:|
| MasterCTF working snapshot | private local copy, base `5e69583856878f3d1f92ee1f75924e195bba309c` plus working changes; Tolk-file manifest SHA-256 `003ee9e49e87bc3ef657fd7f787807e31c40c582a03b7dc71133cc143929573f` | 1.5.0, Acton 1.2.1-trunk | 116 | 94 | 22 generated `gen/` files ignored by project configuration | 0 |
| Counter | [ton-org/docs-examples](https://github.com/ton-org/docs-examples/tree/9db211db732fd2288c4aec2d99b7896f40cd2cba/guidebook/first-smart-contract/Example) `9db211db732fd2288c4aec2d99b7896f40cd2cba` | project requests tolk-js >=1.0.0; verified with 1.5.0 | 1 | 1 | 0 | 0 |
| Jetton | [ton-blockchain/acton-contracts](https://github.com/ton-blockchain/acton-contracts/tree/d721c3179696b453a9490fcfd2f30770f8c234b4/jetton-v2.1) `d721c3179696b453a9490fcfd2f30770f8c234b4` | Acton 1.2.0; verified with Tolk 1.5.0 | 29 | 29 | 0 | 0 |

Raw inventory deliberately includes ignored Tolk source; exclusion is reported separately from parse failure. A separate raw parser sweep covered all 146 files with zero ERROR/MISSING nodes, including the 22 ignored generated files. The original unpatched official grammar rejected numeric separators in two private helper scripts; Tolk 1.5.0 accepted that syntax. The shipped one-line numeric-literal patch corrected this discrepancy.

The before arm indexed zero Tolk files in all three projects. It still reported 101 files / 1,230 nodes in the private copy and found mainly TypeScript wrappers for MasterCTF: those totals were not accepted as Tolk evidence. The changed source arm indexed 195 total files / 3,667 nodes / 5,719 edges in the same private copy, of which 94 files are Tolk.

MasterCTF acceptance checked `contracts/core/MasterCTF.tolk`, its exact file source, contract descriptor, `load`, `takeRequestId`, `dispatchStatistics`, `onInternalMessage` and `statistic_address`. Four local imports and three known call pairs passed, including the statistics helper in another file. Forbidden edges to TypeScript and other contracts' entrypoints were absent. Counter checked three getter/entrypoint-to-Storage calls; Jetton checked three wallet-to-helper/storage calls and three imports. Three deterministic flow prompts per corpus were also exercised through MCP. Direct call edges are checked in the graph and symbol trails: the existing explore renderer suppresses its Flow section for two-node paths, so a direct call need not produce that heading. Its shared path finder was independently checked on Counter and returned the correct getter-to-load edge.

Resolved/unresolved totals below include all reference kinds, not just function calls. Unresolved entries carry diagnostics; they are not silently bound to a same-named project symbol.

| Corpus | Resolved references | Unresolved references | Named graph assertions |
|---|---:|---:|---|
| MasterCTF | 1,060 | 3,970 | PASS |
| Counter | 5 | 6 | PASS |
| Jetton | 572 | 1,441 | PASS |

## Automated checks

| Check | Result |
|---|---|
| Baseline npm ci/build and relevant existing tests | PASS; 1,020 tests in four existing files |
| Grammar health via existing check-grammar.mjs with explicit WASM/sample | PASS; ABI15, 20 repeat parses, 29 companion grammars, ~1 MiB sample, clean exit |
| Reproducible grammar compilation | Same final SHA-256 across repeated pinned Emscripten builds; generation ran in WSL and compilation through Windows Docker |
| Windows final TypeScript + focused integration | PASS; tsc and 43 tests in nine files |
| WSL final npm ci/build + focused integration | PASS; 43 tests in nine files, including real POSIX symlink containment |
| Sync versus independently fresh index | PASS; exact normalized nodes/edges after return/receiver/mapping/import changes, addition, rename and deletion |
| Verifier negative checks | Wrong symbol expectations fail; escaping source/config links are refused |
| Real source CLI | Explicit build init/status/files/query/node/explore PASS; three named graph verifiers PASS |
| Native Linux watcher in extracted bundle | PASS; a synthetic .tolk edit replaced the exact old symbol with the new one through CodeGraph.watch |
| MCP client error paths | Wrong expectation fails and leaves no server PID; non-executable command reports EACCES without signaling an undefined PID |

Baseline full `npm test` exited 1: 3 failing / 745 passing / 17 skipped files; 3 failing / 8,558 passing / 401 skipped tests. Failures were the successor/candidate wait in `daemon-older-version.test.ts`, PPID shutdown in `mcp-ppid-watchdog.test.ts`, and second direct writer exit in `mcp-writer-lock.test.ts`.

The initial source full run exited 1 with 2 failing / 750 passing / 17 skipped files and 2 failing / 8,579 passing / 401 skipped tests: the same daemon-version and writer-lock failures, while PPID passed. The final post-repair full run exited 1 with 4 failing / 749 passing / 17 skipped files and 6 failing / 8,581 passing / 401 skipped tests. Its additional three failures were daemon shutdown/idle/paired-lock timing cases in `mcp-daemon.test.ts`. Sequential focused comparison reproduced the socket/idle failures on baseline (2 failed / 20 passed); source had these plus the paired-lock timeout (3 failed / 19 passed). An isolated run of the exact paired-lock test then failed on baseline (5-second timeout) and passed on source. Thus every observed failure was reproduced on the unchanged base, though their occurrence is timing-sensitive. No Tolk test failed and no existing assertion was weakened. Full-suite results remain FAIL, not green. The final full run overlapped lightweight MCP checks; the focused and isolated comparisons ran sequentially without other checks.

## MCP and distribution

Acceptance uses actual newline-delimited JSON-RPC clients, not a server launched without traffic. Each corpus checks initialize, tools/list, file source, named symbol, and three flow queries. `CODEGRAPH_MCP_TOOLS=explore,node` is explicit because this upstream version defaults to exposing only explore. `CODEGRAPH_DIR` selects the corresponding index in every CLI/client invocation; daemon sharing and prompt hooks are disabled for isolation.

Online EOF-only teardown intermittently hangs on the immutable baseline and on changed source. The client requests the supported graceful SIGTERM handler and requires exit code 0; a forced SIGKILL is a failure. Some source probes still required forced cleanup; they remain recorded rather than being presented as passes. A bounded diagnostic found engine shutdown settled before the stall, with TLS sockets still present; the exact native cause was not established. Disabling network update checks produced three consecutive clean Counter exits. Final acceptance therefore explicitly sets `CODEGRAPH_NO_UPDATE_CHECK=1`, in addition to the same no-daemon/query-pool isolation used by the documented configuration. No old MCP server supplied these responses: each client's exact executable, argv, PID, index name and exit are captured.

The self-contained archive was built using `bash scripts/build-bundle.sh linux-x64 v24.22.1` (33 seconds), with npm 11.19.1. It contains the official verified Node v24.22.1 runtime, 30 engine grammar assets (69 WASM files including dependencies), schema, viewer, Tolk license/provenance/patch and no native kernel. Archive size: 61,152,514 bytes. SHA-256: `6e68deccd7531546856af701c7390c3cd85a68771fe08e330936cad3bde16087`.

The archive was extracted into `/tmp/codegraph-tolk-20261027/bundle-check-final`, outside both checkouts. During acceptance, source and baseline checkout paths were temporarily unavailable; acceptance scripts were copied to a separate temporary kit. The bundled launcher and Node were used, with fresh `.codegraph-bundle-final` indices and isolated HOME. Grammar hash and all three sidecars matched the source assets; schema/viewer were present. All 19 CLI/verifier/MCP commands passed:

| Extracted-bundle check | MasterCTF | Counter | Jetton |
|---|---|---|---|
| Fresh init, status, .tolk files, named graph verifier | PASS | PASS | PASS |
| File/symbol source and three MCP query cases | 7 checks PASS | 7 checks PASS | 7 checks PASS |
| MCP graceful SIGTERM | exit 0, no forced stop | exit 0, no forced stop | exit 0, no forced stop |
| Parse issues / indexed Tolk files | 0 / 94 | 0 / 1 | 0 / 29 |

Bundle MasterCTF query/node/explore and --version also passed. Init wall times were approximately 14 / 1 / 3 seconds respectively; these are local observations, not a performance benchmark. The three verifier inventories and reference totals matched the source results above. All 436 app build input files were also compared between the Linux build overlay and this branch (text line endings normalized): manifest SHA-256 `4750de33a13848a69346b60f4d5d6fe847bc055f9dabbf9c72ae888b6d531dfd`. The manifest accompanies the local archive, binding its application inputs to the committed source even though final validation prose was written after packaging. A deliberately wrong MCP expectation failed and its server PID was absent afterward; all positive server PIDs were also absent. Both checkouts were restored. The local release directory contains the archive, SHA256SUMS and build manifest. Windows global config/npm shim hashes still matched the pre-test snapshots. The isolated actual MCP configuration is retained in the Windows workspace at `.tmp-tolk/mcp-bundle-test-config.json`; it was never activated globally. After acceptance, WSL restarted and cleared `/tmp`, so the raw Linux logs, temporary indices and private corpus/expectation copies are no longer available. The archive, checksum, build-input manifest, 19-command result ledger, runtime receipt and agent-written aggregate reports had already been copied to the Windows workspace. The observations above describe executed runs, not the current existence of those temporary paths; public snapshot checks remain reproducible from the committed expectations.

## Limits and reproducibility

See [support and connection instructions](tolk-support.md) for commands, exact public snapshots, independent expectation files, extraction/version behavior, MCP configuration and concrete rollback executable. `@stdlib` bodies, composite/generic receiver substitution, arbitrary dynamic calls, TVM/message behavior and TS-to-Tolk ABI bridges are deliberately outside this static coverage. Mapping edits require explicit sync. The grammar rebuild script's default Docker path could not run end-to-end inside this WSL because its Docker socket was unavailable; equivalent pinned generation/compilation and repeated hash checks were performed without changing global Docker configuration.

Paid agent A/B runs were not authorized or run. No token-saving or agent-speed claim is made. No npm publication, upstream PR, global install replacement, or agent-configuration activation was performed.
