# Tolk validation record

Date: 2026-10-27. This supersedes the initial `6e44463b` acceptance for the amended implementation. Tests used isolated copies and indices. The live installation, original project index and Codex configuration were preserved. Private source and raw private responses are not committed. Upstream merge readiness still needs agent benchmarks and large-repository coverage.

## Identity and environment

- Immutable upstream base: `69af19ace270f2e940444d514de6dde971df12df`, package `1.6.2`. Remote main was checked again during this amendment and still matched. The original implementation was `6e44463b84f5ef0dfcbe36cab177c5e122dd3110`; package version alone does not identify either build.
- Windows x64 focused tests; actual WSL2 Ubuntu 24.04 Linux x64 acceptance. Linux Node 24.22.1 with built-in `node:sqlite`. Builds and corpus copies are on Linux ext4. The bundle carries its own Linux Node of the same version.
- Official grammar: [Acton](https://github.com/ton-blockchain/acton/tree/b8407f0e628860311d391eff85d003ec9c2cfb2c/crates/tree-sitter-tolk), commit `b8407f0e628860311d391eff85d003ec9c2cfb2c`, MIT, no local patches. Its package still says `0.4.5`, despite different syntax/AST coverage. Tested compiler: Tolk 1.5.0.
- WASM SHA-256: `663a425723b0b71bcb990136149b9cb7be83fee80825fe321b15583ef6ebc921`. Tree-sitter CLI 0.26.3, ABI15, Emscripten 4.0.16. A task-local SDK at commit `526ceebf902920582fc6979fcb65c50f1648aaeb` enabled repeated native builds and the complete rebuild recipe without starting Docker or changing global tooling. See [provenance](../src/extraction/wasm/tree-sitter-tolk.PROVENANCE.md).
- All 525 nominated application/build inputs were verified against the Linux overlay, normalizing text line endings. Manifest SHA-256: `a09b0cff06011740355a5300bba043c7fd175ef69e7e1e546733cd1c930d9851`. The manifest accompanies the archive and identifies application inputs independently of later documentation edits.

## Repairs and automated checks

The grammar accepts compiler-valid tensor/tuple trailing commas, numeric separators and contract declarations. The adapter follows the actual local-declaration AST. Receiver inference preserves lexical shadows, generic type erasure and direct-import/Tolk-only boundaries. Simple named match arms supply local type evidence; assignments and mutation discard stale facts. Compiler-backed regressions cover implicit union `mutate self`, explicit mutate argument timing, assigned globals and parenthesized/tensor/tuple reassignment. Known same-type chains remain resolved. Immutable bounded proof data survives reference retries, inferred returns and sync.

The verifier fails on every indexed Tolk parse diagnostic even when other declarations recover. Explore prioritizes a path-pinned caller and its actual direct static neighbors before candidate caps; a 64-contract Tolk/TypeScript regression verifies the correct same-name body beyond the 50-hit full-text cutoff. Explore budgets and graph edges are unchanged by that rendering fix.

| Check | Final result |
|---|---|
| Grammar health, explicit WASM/sample | PASS: 20 clean repeat parses, 29 companion grammars, approximately 1 MiB sample, normal exit |
| Grammar reproducibility | PASS: identical pinned SHA across native builds and complete rebuild recipe |
| Windows focused | PASS: 75 tests in 9 files, including 12 call-proof tests |
| WSL npm ci/build/assets | PASS: Linux dependencies, TypeScript/viewer build, 30 engine grammars |
| WSL focused extraction/resolution/sync/explore | PASS: 1,111 tests in 15 files |
| Final full npm test | PASS: 8,622 tests in 755 files; 401 tests / 17 files skipped; exit 0, 759.58 seconds |
| Sync versus genuinely new DB | PASS: exact normalized nodes/edges after add/edit/rename/delete, imports/mappings, receiver/return changes, match edits and imported-method mutation |
| Negative safeguards | PASS: no guessed TS/legacy/transitive-import targets; shadows, unknown/ambiguous receivers, generic limits, proof overflow, malformed source and containment |

The final full command was `npm test -- --maxWorkers=4 --minWorkers=1 --reporter=default --reporter=json`, with no concurrent indexing/build. It runs the complete suite with a worker cap, without changing assertions. Regression-first failing receipts remain. A new multi-rebuild sync test exceeded the default 5 seconds on Windows; its assertions remain intact and it uses the repository's 30-second heavy-sync allowance. Compiler-rejected postfix assignment and mutate tuple/tensor forms are not claimed as valid syntax coverage.

## Real source acceptance

Expectations were prepared independently from pinned source before graph output. Public fixtures contain facts/endpoints; Webdom contract bodies are not vendored because no project license was declared. Every source run used an explicit build, fresh `CODEGRAPH_DIR`, CLI version/init/status/files/query/node/explore, and an actual stdio JSON-RPC client.

| Corpus | Pin and compiler evidence | Raw→indexed Tolk | All indexed files | Exclusions | Parse issues |
|---|---|---:|---:|---|---:|
| [Webdom](https://github.com/webdom-market/webdom-contracts), main | `187e0589f437fe398e3385f4a434e9755d1b4d87`; tolk-js 1.4.1 |78→78|203|none|0|
| [Acton contracts](https://github.com/ton-blockchain/acton-contracts), default master, never skills | `d721c3179696b453a9490fcfd2f30770f8c234b4`; Acton 1.2.0, separate compiler pin unspecified |215→215|216|none|0|
| [Acton](https://github.com/ton-blockchain/acton), master | `b8407f0e628860311d391eff85d003ec9c2cfb2c`; Acton 1.2.1, bundled Tolk 1.5.0, compiler `9334027d63528da1a78b2efbe898bc586d4e6cec` |181→178|2,936|3 intentional compilation-error fixtures|0|
| [TON](https://github.com/ton-blockchain/ton), master | `857b8a57a178e6ae0fe7fa86e7d81c5233de8560`; Tolk 1.5.0 |681→120|1,692|561 intentional invalid compiler fixtures|0|
| [TG Wallet](https://github.com/ton-blockchain/tg-wallet-contract), master | `1a29ae5d90e03c3d585d3e42e6ecef691d727a3c`; Acton 1.2.0, separate compiler pin unspecified |18→18|19|none|0|
| private local Tolk snapshot | local Tolk 1.5.0 toolchain metadata |138→138|239|none|0|

Acton/TON exclusions were specified from source before indexing in disposable copies' `codegraph.json`, with configurations in expectation provenance. They are not waived parser errors. `@stdlib` stays external; TON's comment-based compiler-test `@custom-folder` mapping is outside Acton mapping coverage. The private local Tolk snapshot was not recompiled; its compiler identity comes from local toolchain metadata. It differs from the earlier 94-file snapshot; totals are not a before/after performance or coverage comparison.

| Corpus | Symbols | Expected calls | Local imports | Forbidden pairs | Actual MCP |
|---|---:|---:|---:|---:|---|
| Webdom |22 PASS|20/20|13/13|15 absent|11 checks PASS, 3 numbered flows and 3 incoming trails|
| Acton contracts |30 PASS|31/31|72/72|12 absent|21 checks PASS: 10 contract-group files, source/node checks, queries, incoming trails and 2 numbered flows|
| Acton |14 PASS|11/11|11/11|6 absent|11 checks PASS, 3 numbered flows and 3 incoming trails|
| TON |17 PASS|14/14|4/4|5 absent|12 checks PASS, 3 numbered flows and shortcut-branch incoming evidence|
| TG Wallet |11 PASS|**9/10, partial**|10/10|6 absent|10 checks pass; third numbered flow fails at the same unsupported generic-dependent hop|
| private local Tolk snapshot |12 PASS|11/11|4/4|2 absent|10 checks PASS: source/entrypoint checks, 3 queries and 3 incoming trails|

Acton contracts also passed all 31 receiver-qualified call-site assertions from the original independent oracle. Counter explore returns `Storage.load` from `counter/contracts/types.tolk`. Private local Tolk snapshot acceptance returns all 11 expected targets; detailed source and edge evidence remains in the existing private corpus reports. A TVM entrypoint need not have static incoming calls; message delivery is outside this model.

Counts below are diagnostics, not correctness proofs. Specific endpoints and forbidden targets are checked above. Unresolved references retain diagnostics rather than arbitrary same-name links.

| Corpus | Resolved/unresolved calls | Resolved/unresolved imports | Init wall seconds |
|---|---:|---:|---:|
| Webdom |686/1,893|348/42|3.86|
| Acton contracts |4,329/11,968|642/624|45.12|
| Acton |1,373/4,390|228/396|72.33|
| TON |2,222/8,389|5/31|63.14|
| TG Wallet |420/1,152|48/48|2.65|
| private local Tolk snapshot |1,758/4,798|412/345|24.23|

Times are local observations, not agent benchmarks. Complete found/indexed inventories, exclusions, parse diagnostics, returned source, references and PID/exit receipts remain locally in `.tmp-tolk/pr-readiness/acceptance/`. Reproduce public cases with [committed expectations](../scripts/tolk-expectations) and the [explicit-build verifier](../scripts/verify-tolk.mjs).

## Non-green results and corrected oracles

- TG Wallet's strict verifier still exits1: `parseArrayAndSend` invokes `validateAndSend` on `s.loadAny<MessageToSend>()` output. Generic stdlib return substitution is outside declared receiver coverage. Two match-dependent missing calls are fixed; the generic expectation remains. The third MCP flow also fails, with normal server exit 0. This corpus is partial, not PASS.
- An initial stronger TON oracle required `onExternalMessage→cleanupRegistry→getLastKeyBlockSeqno` as three Flow nodes, although source/graph also has the direct first→last edge. Unchanged upstream BFS keeps one shortest route per reached node, then selects a deepest retained destination; two-node Flow headings are omitted. Independent review classified the oracle as overstrict. All three edge assertions remain; a node trail checks both callers, and three other already-frozen chains without that shortcut pass numbered checks. Failed oracle/receipt retained. Named mode does not guarantee the globally longest route or every named intermediate.
- The private local Tolk snapshot's initial oracle was corrected against source and graph evidence. All 11 original call assertions remain; detailed oracle evidence stays in the existing private corpus reports. `codegraph_node` trails cap each direction at 12; absence from that prefix does not prove an absent edge.
- Historical full runs on the initial implementation and immutable base had timing-dependent daemon/writer-lock/PPID failures; every observed failure was reproduced on the base. An intermediate amendment full run passed 8,592 tests but predates later repairs and is not final evidence. The final full result is separate above.

## Extracted archive and MCP

`release/codegraph-tolk-pr-linux-x64.tar.gz`, 61,164,430 bytes, Linux x64/Node 24.22.1. Archive SHA-256: `dab7de527ee8f967cb645b8023bd400daed8d6c355bc33a817463f969952307f`. Built with `bash scripts/build-bundle.sh linux-x64 v24.22.1`; the downloaded Node archive matched Node.js SHASUMS256. Adjacent files carry checksum, build-input manifest and receipt. This local archive is not published to npm or GitHub Releases.

The archive was extracted outside source. Grammar/license/provenance hashes matched, the obsolete patch was absent, schema/viewer existed, and bundled Node reported Linux/x64 with `node:sqlite`. During acceptance the Linux development checkout was unavailable; verifier/client scripts were copied to a separate kit. The bundled launcher/Node created independent fresh indices for Webdom, full Acton contracts and the private local Tolk snapshot. All CLI/verifier/MCP checks passed, including 31 qualified Acton call sites. The Linux native watcher replaced an exact `.tolk` symbol after an edit. The checkout was restored.

For all three copies, source and bundle had equal indexed Tolk sets, selected symbol/source records, resolved/unresolved references, diagnostics and failures after removing only node `updatedAt` timestamps. Independent fresh-index sync tests compare normalized nodes/edges separately.

The actual client checks initialize/tools-list, source and graph-backed trails/flows. Query-echoed paths alone are not flow proof. Every process uses the selected index, absolute executable and fresh PID. Update checks, shared daemons, query pools and prompt hooks are disabled for isolation. Graceful SIGTERM must exit 0; a forced stop fails acceptance. All final positive servers exited0, as did the intentionally failing TG flow's server.

Exact previous launcher, index and configuration details are retained in the private rollback record. This amendment does not activate a replacement MCP configuration. See [connection and rollback instructions](tolk-support.md).

## Remaining merge gates

The user subsequently requested Codex on the ChatGPT subscription, explicitly replacing Claude. The [Codex pilot report](benchmarks/tolk-codex-pilot.md) records twelve completed answers plus two retained infrastructure failures: 28/30 in both arms, CodeGraph adoption 2/6 enabled sessions, and no demonstrated speed improvement. Both arms omitted one required local import in the sale-reserve task. It is not the upstream Sonnet/high benchmark: medium/large agent packs, baseline/new control and missing feedback metrics remain open. No token-saving or general agent-speed claim is made.

A source-grounded [A/B protocol and evaluator key](benchmarks/tolk-agent-ab.md) document the original Sonnet pilot, medium extension and baseline/new JavaScript control. Only the separately documented Codex pilot was executed; the other packs remain preparation.

The largest genuinely indexed corpus here has 2,936 files (Acton), a medium tier. Raw 6,891 tracked Acton files do not establish large-index coverage. A real large corpus and its 3 flow probes/A-B remain unverified; none was fabricated by padding. These small/medium deterministic results therefore do not establish all upstream merge gates.

Other limits: generic/composite receiver substitution, unindexed stdlib bodies, dynamic callbacks, arbitrary import systems, TVM/messages, TS↔Tolk ABI bridges and native Rust Tolk extraction. Mapping edits require explicit sync. Fresh indices are required across grammar/fork revisions sharing extraction version 29. No npm publication or upstream PR submission occurred.
