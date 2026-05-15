#!/usr/bin/env bash
# Build the Luau analyzer (Luau.Analysis) to WebAssembly.
#
# Reuses the Luau source already cloned for the parser build. If
# packages/luau-parser/build/luau/ doesn't exist (e.g. fresh checkout),
# clones into ./luau locally.
#
# Output: wasm/luau-analyzer.mjs (Emscripten glue) + wasm/luau-analyzer.wasm
# Artifacts are committed to the repo; rerun only when the wrapper or
# the pinned Luau version changes.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

LUAU_DIR="luau"
if [ ! -d "$LUAU_DIR" ]; then
  echo ">> Cloning luau-lang/luau (depth 1)..."
  git clone --depth 1 https://github.com/luau-lang/luau "$LUAU_DIR"
fi

OUT_DIR="../src/wasm"

# Locate emcc.bat (Windows) or emcc (Unix).
EMCC=""
is_windows=false
case "$(uname -s 2>/dev/null || echo "${OS:-}")" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT) is_windows=true ;;
esac
if [ "${OS:-}" = "Windows_NT" ]; then is_windows=true; fi

if $is_windows; then
  EMCC="emcc.bat"
  if ! command -v emcc.bat >/dev/null 2>&1; then
    if [ -f "/c/Users/tonyt/scoop/apps/emscripten/current/emsdk_env.sh" ]; then
      echo ">> Sourcing emsdk env..."
      # shellcheck source=/dev/null
      source "/c/Users/tonyt/scoop/apps/emscripten/current/emsdk_env.sh" >/dev/null 2>&1
    fi
  fi
else
  EMCC="emcc"
fi

mkdir -p "$OUT_DIR"

# Regenerate the embedded Roblox-globals header before invoking emcc, so
# wrapper.cpp picks up the latest roblox-globals.d.lua contents. The script
# is a fast no-op when nothing changed.
echo ">> Embedding roblox-globals.d.lua into roblox_globals_data.h..."
node embed-globals.mjs

echo ">> Building $OUT_DIR/luau-analyzer.mjs with $EMCC..."

# Collect every .cpp under the modules we need. Globbing keeps the
# script stable as Luau adds new source files.
shopt -s nullglob   # unmatched globs expand to nothing, not the literal pattern
ANALYSIS_SRCS=("$LUAU_DIR"/Analysis/src/*.cpp)
AST_SRCS=("$LUAU_DIR"/Ast/src/*.cpp)
COMMON_SRCS=("$LUAU_DIR"/Common/src/*.cpp)
CONFIG_SRCS=("$LUAU_DIR"/Config/src/*.cpp)
# Analysis pulls in Bytecode + Compiler + VM transitively for
# user-defined type functions (Lua code that runs at type-check time
# to produce types). Skipping any of these breaks the link.
BYTECODE_SRCS=("$LUAU_DIR"/Bytecode/src/*.cpp)
COMPILER_SRCS=("$LUAU_DIR"/Compiler/src/*.cpp)
VM_SRCS=("$LUAU_DIR"/VM/src/*.cpp)
# EqSat was used by an earlier solver iteration. Modern Luau (this clone)
# doesn't include it; the new constraint solver lives entirely inside
# Analysis/. The glob expands to nothing thanks to nullglob.
EQSAT_SRCS=("$LUAU_DIR"/EqSat/src/*.cpp)

"$EMCC" \
  -O2 \
  -std=c++17 \
  -fexceptions \
  -DLUAU_ENABLE_TIME_TRACE=0 \
  -I"$LUAU_DIR/Ast/include" \
  -I"$LUAU_DIR/Common/include" \
  -I"$LUAU_DIR/Analysis/include" \
  -I"$LUAU_DIR/Bytecode/include" \
  -I"$LUAU_DIR/Compiler/include" \
  -I"$LUAU_DIR/Config/include" \
  -I"$LUAU_DIR/VM/include" \
  -I"$LUAU_DIR/VM/src" \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s ENVIRONMENT=node,web \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=67108864 \
  -s ALLOW_TABLE_GROWTH=1 \
  -s EXPORT_NAME=createLuauAnalyzerModule \
  -s EXPORTED_FUNCTIONS='["_luau_analyze","_luau_analyzer_free","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["UTF8ToString","HEAPU8"]' \
  -s ASSERTIONS=0 \
  "${ANALYSIS_SRCS[@]}" \
  "${AST_SRCS[@]}" \
  "${BYTECODE_SRCS[@]}" \
  "${COMMON_SRCS[@]}" \
  "${COMPILER_SRCS[@]}" \
  "${CONFIG_SRCS[@]}" \
  "${EQSAT_SRCS[@]}" \
  "${VM_SRCS[@]}" \
  wrapper.cpp \
  -o "$OUT_DIR/luau-analyzer.mjs"

echo ">> Done."
ls -la "$OUT_DIR"
