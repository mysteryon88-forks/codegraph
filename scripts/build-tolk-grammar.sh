#!/usr/bin/env bash
# Build the pinned official Acton grammar without local modifications.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_sha=b8407f0e628860311d391eff85d003ec9c2cfb2c
image=emscripten/emsdk@sha256:69820cfa8dd489d1ddd13bb394b9b9a80b491fb6a3b44715622b5cba0e5f49fb
expected=663a425723b0b71bcb990136149b9cb7be83fee80825fe321b15583ef6ebc921
work="$(mktemp -d "${TMPDIR:-/tmp}/codegraph-tolk-grammar.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
[[ "$(tree-sitter --version)" == 'tree-sitter 0.26.3'* ]] || { echo 'Requires tree-sitter CLI 0.26.3 on PATH (no global installation performed)' >&2; exit 1; }
git init --quiet "$work/upstream"
git -C "$work/upstream" remote add origin https://github.com/ton-blockchain/acton.git
git -C "$work/upstream" sparse-checkout set crates/tree-sitter-tolk
git -C "$work/upstream" fetch --depth=1 --filter=blob:none origin "$source_sha"
git -C "$work/upstream" -c advice.detachedHead=false checkout --detach "$source_sha"
grammar="$work/upstream/crates/tree-sitter-tolk"
cd "$grammar"
tree-sitter generate --abi 15 grammar.js
compile() {
  if [[ "${TOLK_NATIVE_EMCC:-0}" == 1 ]]; then
    emcc --version | head -1 | grep -F '4.0.16' >/dev/null || { echo 'Requires emcc 4.0.16' >&2; exit 1; }
    emcc -O2 -s SIDE_MODULE=2 '-sEXPORTED_FUNCTIONS=["_tree_sitter_tolk"]' -I src src/parser.c -o "$1"
  else
    docker run --rm --init --user "$(id -u):$(id -g)" -e EM_CACHE=/tmp/emscripten-cache -v "$grammar:/src" -w /src "$image" \
      emcc -O2 -s SIDE_MODULE=2 '-sEXPORTED_FUNCTIONS=["_tree_sitter_tolk"]' -I src src/parser.c -o "$1"
  fi
}
compile first.wasm
compile second.wasm
cmp first.wasm second.wasm
echo "$expected  first.wasm" | sha256sum --check
cp first.wasm "$repo_root/src/extraction/wasm/tree-sitter-tolk.wasm"
echo "Tolk grammar reproduced: $expected (ABI 15, upstream $source_sha)"
