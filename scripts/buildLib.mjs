// @ts-check
import { context, build } from 'esbuild'
import { polyfillNode } from 'esbuild-plugin-polyfill-node'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import { createEsbuildDataPlugin } from './esbuildDataPlugin.mjs'

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)))
const rootDir = path.join(__dirname, '..')

const watch = process.argv.includes('-w')
const minify = process.argv.includes('--minify')

// Files that need to be dynamically loaded
const dynamicMcDataFiles = ['blocks', 'blockCollisionShapes', 'biomes', 'version']
const allowedBundleFiles = ['legacy', 'versions', 'protocolVersions', 'features']

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  entryPoints: [path.join(rootDir, './src/index.ts')],
  outfile: path.join(rootDir, './dist/minecraft-renderer.js'),
  minify: minify,
  minifyIdentifiers: false,
  logLevel: 'info',
  drop: minify ? ['debugger', 'console'] : [],
  sourcemap: !minify,
  metafile: true,
  define: {
    'process.env.NODE_ENV': watch ? '"development"' : '"production"',
    'process.env.BROWSER': '"true"',
    'globalThis.includedVersions': '["1.16.4", "1.16.5", "1.18.2", "1.19.4", "1.20.1", "1.21.4"]'
  },
  loader: {
    '.png': 'dataurl',
    '.webp': 'dataurl',
    '.obj': 'text',
    '.json': 'json'
  },
  external: [
    // External dependencies that should not be bundled
    'three',
    'vec3',
    'valtio',
    'minecraft-data',
    'prismarine-*',
    'mc-assets'
  ],
  plugins: [
    createEsbuildDataPlugin({ inlineTints: true }),
    polyfillNode({
      // Only polyfill specific modules we need
      globals: {
        process: true,
        buffer: true,
        global: true
      },
      polyfills: {
        path: true,
        util: true,
        events: true,
        stream: true,
        buffer: true,
        crypto: true
      }
    })
  ]
}

// Build or watch
if (watch) {
  console.log('🔄 Starting watch mode...')
  const ctx = await context(buildOptions)
  await ctx.watch()
  console.log('👀 Watching for changes...')
} else {
  console.log('🔨 Building library...')
  const result = await build(buildOptions)
  if (result.metafile) {
    const metaPath = path.join(rootDir, './dist/minecraft-renderer.js.meta.json')
    fs.writeFileSync(metaPath, JSON.stringify(result.metafile))
    console.log('  metafile:', metaPath)
  }
}
