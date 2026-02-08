//@ts-check
import { build } from 'esbuild'
import path from 'path'
const VERSION = '1.16.5'

build({
    entryPoints: [path.join(import.meta.dirname, './test-chunk.ts')],
    outfile: path.join(import.meta.dirname, './wasm-mesher.cjs'),
    bundle: true,
    format: 'cjs',
    logLevel: 'info',
    platform: 'node',
    sourcemap: true,
    // plugins: [minecraftDataPatchPlugin],
    external: ['minecraft-data', './pkg/wasm_mesher.js'],
})
