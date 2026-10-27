# Tolk grammar provenance

- Upstream: https://github.com/ton-blockchain/acton
- Commit: `b8407f0e628860311d391eff85d003ec9c2cfb2c`
- Subtree: `crates/tree-sitter-tolk`
- License: MIT, Copyright (c) 2024 TON Core; see `tree-sitter-tolk.LICENSE`.
- Local changes: none. Numeric separators and tensor/tuple trailing commas are included upstream.
- Generator: Tree-sitter CLI 0.26.3, `tree-sitter generate --abi 15 grammar.js`.
- Compiler: Emscripten 4.0.16, Docker image `emscripten/emsdk@sha256:69820cfa8dd489d1ddd13bb394b9b9a80b491fb6a3b44715622b5cba0e5f49fb`.
- Compile: `emcc -O2 -s SIDE_MODULE=2 -s EXPORTED_FUNCTIONS='["_tree_sitter_tolk"]' -I src src/parser.c -o tree-sitter-tolk.wasm`.
- Generated `src/parser.c` SHA256: `d70be5c5e6a383115a2e9990d559cb74aa6a608dfeb95e171d4e641eadad905b`.
- Shipped WASM SHA256: `663a425723b0b71bcb990136149b9cb7be83fee80825fe321b15583ef6ebc921`.

Run `bash scripts/build-tolk-grammar.sh` with the pinned Tree-sitter CLI already available and Docker. `TOLK_NATIVE_EMCC=1` uses an existing emcc 4.0.16 instead. The script modifies no global tooling, builds twice, compares outputs, and verifies the pinned hash before copying the artifact. Temporary sources live under system TEMP and are removed on exit.

The shipped artifact is generated from the pinned grammar source, not an upstream prebuilt file. Two consecutive native Emscripten 4.0.16 builds produced the same checksum.
