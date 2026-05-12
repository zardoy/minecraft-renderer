//@ts-check
import { build } from 'esbuild'
import path from 'path'
const VERSION = '1.16.5'

const common = {
    bundle: true,
    format: 'cjs',
    logLevel: 'info',
    platform: 'node',
    sourcemap: true,
    // Tests live in ./tests/ and import wasm via '../pkg/wasm_mesher.js'
    external: ['minecraft-data', '../pkg/wasm_mesher.js'],
}

build({
    ...common,
    entryPoints: [path.join(import.meta.dirname, './tests/test-chunk.ts')],
    outfile: path.join(import.meta.dirname, './tests/test-chunk.cjs'),
})

build({
    ...common,
    entryPoints: [path.join(import.meta.dirname, './tests/test-section-boundary.ts')],
    outfile: path.join(import.meta.dirname, './tests/test-section-boundary.cjs'),
})
