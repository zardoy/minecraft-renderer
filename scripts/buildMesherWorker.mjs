// @ts-check
import { context, build } from 'esbuild'
import path from 'path'
import { fileURLToPath } from 'url'
import { createWorkerBuildOptions } from './buildWorkerShared.mjs'
import { dynamicMcDataFiles } from '../src/lib/buildSharedConfig.mjs'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)))
const rootDir = path.join(__dirname, '..')

const watch = process.argv.includes('-w')

// Mesher worker mc-data files
const mesherMcData = [...Object.keys(dynamicMcDataFiles), 'version']

let wasmPlugin = {
  name: 'wasm',
  setup(build) {
    // Resolve ".wasm" files to a path with a namespace
    build.onResolve({ filter: /\.wasm$/ }, args => {
      // If this is the import inside the stub module, import the
      // binary itself. Put the path in the "wasm-binary" namespace
      // to tell our binary load callback to load the binary file.
      if (args.namespace === 'wasm-stub') {
        return {
          path: args.path,
          namespace: 'wasm-binary',
        }
      }

      // Otherwise, generate the JavaScript stub module for this
      // ".wasm" file. Put it in the "wasm-stub" namespace to tell
      // our stub load callback to fill it with JavaScript.
      //
      // Resolve relative paths to absolute paths here since this
      // resolve callback is given "resolveDir", the directory to
      // resolve imports against.
      if (args.resolveDir === '') {
        return // Ignore unresolvable paths
      }
      return {
        path: path.isAbsolute(args.path) ? args.path : path.join(args.resolveDir, args.path),
        namespace: 'wasm-stub',
      }
    })

    // Virtual modules in the "wasm-stub" namespace are filled with
    // the JavaScript code for compiling the WebAssembly binary. The
    // binary itself is imported from a second virtual module.
    build.onLoad({ filter: /.*/, namespace: 'wasm-stub' }, async (args) => ({
      contents: `import wasm from ${JSON.stringify(args.path)}
        export default (imports) =>
          WebAssembly.instantiate(wasm, imports).then(
            result => result.instance.exports)
        export { wasm as wasmBinary }`,
    }))

    // Virtual modules in the "wasm-binary" namespace contain the
    // actual bytes of the WebAssembly file. This uses esbuild's
    // built-in "binary" loader instead of manually embedding the
    // binary data inside JavaScript code ourselves.
    build.onLoad({ filter: /.*/, namespace: 'wasm-binary' }, async (args) => ({
      contents: await fs.promises.readFile(args.path),
      loader: 'binary',
    }))
  },
}

const buildOptions = createWorkerBuildOptions({
  entryPoint: path.join(rootDir, './src/mesher/mesherWasm.ts'),
  bundleMcData: mesherMcData,
  watch,
  esbuildOptions: {
    outfile: undefined,
    outdir: path.join(rootDir, './dist'),
    entryPoints: [path.join(rootDir, './src/mesher/mesherWasm.ts'), path.join(rootDir, './src/mesher/mesher.ts')],
    plugins: [wasmPlugin],
  }
})

if (watch) {
  const ctx = await context(buildOptions)
  await ctx.watch()
} else {
  await build(buildOptions)
}

// remove dist/mesherWasm.js.map for now
fs.unlinkSync(path.join(rootDir, './dist/mesherWasm.js.map'))
