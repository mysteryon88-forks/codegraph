# Tolk grammar provenance

- Upstream: https://github.com/ton-blockchain/ton-language-server
- Commit: `342d87c26b5fab1e300015bf2831cafa59fda457`
- Subtree: `server/src/languages/tolk/tree-sitter-tolk`
- License: MIT, Copyright (c) 2024 TON Core; see `tree-sitter-tolk.LICENSE`.
- Local change: `tree-sitter-tolk.patch` accepts decimal/hex/binary numeric separators, supported by Tolk 1.5.0 and present in real projects. No other grammar modification.
- Generator: Tree-sitter CLI 0.26.3, `tree-sitter generate --abi 15 grammar.js`.
- Compiler: Emscripten 4.0.16, Docker image `emscripten/emsdk@sha256:69820cfa8dd489d1ddd13bb394b9b9a80b491fb6a3b44715622b5cba0e5f49fb`.
- Compile: `emcc -O2 -s SIDE_MODULE=2 -s EXPORTED_FUNCTIONS='["_tree_sitter_tolk"]' -I src src/parser.c -o tree-sitter-tolk.wasm`.
- Shipped WASM SHA256: `4829ff208e5fa1c45ea2b546b608d331bd3fcc7671692edd6f3a250630f1cb8f`.

Run `bash scripts/build-tolk-grammar.sh` with the pinned Tree-sitter CLI already available and Docker. `TOLK_NATIVE_EMCC=1` uses an existing emcc 4.0.16 instead. The script modifies no global tooling, builds twice, compares outputs, and verifies the pinned hash before copying the artifact. Temporary sources live under system TEMP and are removed on exit.

The unmodified upstream prebuilt WASM (`37da8c39589376714246e76fcc3c072ea468e887ccba6bdfba62bfc7d5341164`) passed grammar health checks but lacks numeric separators. The shipped artifact is regenerated from the patched grammar; it is not the unmodified prebuilt file.
