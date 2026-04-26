cd "$(dirname "$0")"
node build.mjs && node test-chunk.cjs
