cd "$(dirname "$0")"
node build.mjs && node wasm-mesher.cjs
