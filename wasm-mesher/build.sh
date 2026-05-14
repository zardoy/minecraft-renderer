#!/bin/bash

# Build WASM mesher
# Usage: ./build.sh [web|nodejs|both] [--clean|--dev]
# Default: both
# Options:
#   --clean  - Clean build artifacts before building (cargo clean)
#   --dev    - Build in dev mode (faster, larger, includes debug info)

set -e

cd "$(dirname "$0")"

# Parse arguments
TARGET="web"
CLEAN=false
DEV_MODE=false

for arg in "$@"; do
  case "$arg" in
    web|nodejs|both)
      TARGET="$arg"
      ;;
    --clean)
      CLEAN=true
      ;;
    --dev)
      DEV_MODE=true
      ;;
    *)
      echo "Unknown argument: $arg"
      exit 1
      ;;
  esac
done

# Clean if requested
if [ "$CLEAN" = true ]; then
  echo "🧹 Cleaning build artifacts..."
  cargo clean
  echo ""
fi

# Build flags
BUILD_FLAGS=""
if [ "$DEV_MODE" = true ]; then
  BUILD_FLAGS="--dev"
  echo "🔧 Building in DEV mode (faster compilation, includes debug info)"
else
  echo "🔧 Building in RELEASE mode (optimized, smaller binary)"
fi

# Output dir: src/wasm-mesher/runtime-build (consumed by worker via dynamic import)
OUT_DIR="$(cd .. && pwd)/src/wasm-mesher/runtime-build"
# Node test expects wasm in wasm-mesher/pkg (nodejs target for require())
PKG_DIR="$(pwd)/pkg"

case "$TARGET" in
  web)
    echo "🔨 Building WASM mesher for web target..."
    wasm-pack build --target web --out-dir "$OUT_DIR" $BUILD_FLAGS
    echo "✅ Build complete! (web target)"
    echo "📦 Output: $OUT_DIR"
    echo "   Files: wasm_mesher.js, wasm_mesher_bg.wasm, wasm_mesher.d.ts"
    # Build nodejs to pkg for snapshot test (chunk.json vs wasm-chunk.snapshot.json)
    echo ""
    echo "🔨 Building for nodejs (snapshot test)..."
    wasm-pack build --target nodejs --out-dir "$PKG_DIR" $BUILD_FLAGS
    echo "🧪 Running WASM snapshot test (chunk.json → wasm-chunk.snapshot.json)..."
    node build.mjs && node test-chunk.cjs
    ;;
  nodejs)
    echo "🔨 Building WASM mesher for nodejs target..."
    wasm-pack build --target nodejs --out-dir "$OUT_DIR" $BUILD_FLAGS
    echo "✅ Build complete! (nodejs target)"
    echo "📦 Output: $OUT_DIR"
    echo "   Files: wasm_mesher.js, wasm_mesher_bg.wasm, wasm_mesher.d.ts"
    ;;
  both)
    echo "🔨 Building WASM mesher for both targets..."
    echo ""
    echo "📦 Building for web target..."
    wasm-pack build --target web --out-dir "$OUT_DIR" $BUILD_FLAGS
    echo ""
    echo "📦 Building for nodejs target..."
    wasm-pack build --target nodejs --out-dir "$OUT_DIR" $BUILD_FLAGS
    echo ""
    echo "✅ Build complete! (both targets)"
    echo "📦 Output: $OUT_DIR"
    echo "   Files: wasm_mesher.js, wasm_mesher_bg.wasm, wasm_mesher.d.ts"
    echo "⚠️  Note: nodejs target overwrites web target in wasm/"
    ;;
  *)
    echo "Usage: $0 [web|nodejs|both] [--clean] [--dev]"
    echo "  web|nodejs|both - Target to build (default: both)"
    echo "  --clean          - Clean build artifacts before building"
    echo "  --dev            - Build in dev mode (faster, includes debug info)"
    exit 1
    ;;
esac

# Remove wasm-pack extras we don't ship (only from OUT_DIR; pkg is for testing)
echo "🧹 Removing README, package.json, .gitignore from $OUT_DIR"
rm -f "$OUT_DIR/README" "$OUT_DIR/README.md" "$OUT_DIR/package.json" "$OUT_DIR/.gitignore"
