#!/bin/bash

# Build WASM and run Node.js tests

set -e

cd "$(dirname "$0")"

echo "🔨 Building WASM mesher for nodejs..."
wasm-pack build --target nodejs

echo ""
echo "🧪 Running Node.js tests..."
echo ""

# # Run basic test
# echo "--- Basic Test ---"
# node test-node.js

# echo ""
# echo "--- Warmup Test ---"
# node --expose-gc test-warmup.js

# echo ""
# echo "--- Chunk Test ---"
# npx tsx test-chunk.ts

echo ""
echo "✅ All tests completed!"
