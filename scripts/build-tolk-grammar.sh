#!/usr/bin/env bash
# Build the pinned official grammar plus the numeric-separator compatibility patch.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_sha=342d87c26b5fab1e300015bf2831cafa59fda457
image=emscripten/emsdk@sha256:69820cfa8dd489d1ddd13bb394b9b9a80b491fb6a3b44715622b5cba0e5f49fb
expected=4829ff208e5fa1c45ea2b546b608d331bd3fcc7671692edd6f3a250630f1cb8f
work="$(mktemp -d "${TMPDIR:-/tmp}/codegraph-tolk-grammar.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
[[ "$(tree-sitter --version)" == 'tree-sitter 0.26.3'* ]] || { echo 'Requires tree-sitter CLI 0.26.3 on PATH (no global installation performed)' >&2; exit 1; }
git -c advice.detachedHead=false clone --filter=blob:none --sparse --no-checkout https://github.com/ton-blockchain/ton-language-server.git "$work/upstream"
git -C "$work/upstream" sparse-checkout set server/src/languages/tolk/tree-sitter-tolk
git -C "$work/upstream" -c advice.detachedHead=false checkout --detach "$source_sha"
grammar="$work/upstream/server/src/languages/tolk/tree-sitter-tolk"
git -C "$work/upstream" apply --directory=server/src/languages/tolk/tree-sitter-tolk "$repo_root/src/extraction/wasm/tree-sitter-tolk.patch"
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
echo "Tolk grammar reproduced: $expected (ABI 15, upstream $source_sha plus tree-sitter-tolk.patch)"
