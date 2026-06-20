// @ts-check
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.join(__dirname, '..')
const rootRequire = createRequire(path.join(pkgRoot, 'package.json'))

function loadTintsJson() {
  const mcDataPkg = path.dirname(rootRequire.resolve('minecraft-data/package.json'))
  return rootRequire(path.join(mcDataPkg, 'minecraft-data', 'data', 'pc', '1.16.2', 'tints.json'))
}

/**
 * Virtual module `esbuild-data` for shaderCubeBridge / render-from-wasm / models.ts.
 * @param {{ inlineTints?: boolean }} options — embed tints JSON (buildLib browser bundle)
 */
export function createEsbuildDataPlugin({ inlineTints = false } = {}) {
  return {
    name: 'esbuild-data',
    setup(build) {
      build.onResolve({ filter: /^esbuild-data$/ }, () => ({
        path: 'esbuild-data',
        namespace: 'esbuild-data'
      }))

      build.onLoad({ filter: /.*/, namespace: 'esbuild-data' }, () => {
        if (inlineTints) {
          const tints = loadTintsJson()
          return {
            contents: `module.exports = { tints: ${JSON.stringify(tints)} }`,
            loader: 'js'
          }
        }
        return {
          contents: 'module.exports = { tints: require("minecraft-data/minecraft-data/data/pc/1.16.2/tints.json") }',
          loader: 'js',
          resolveDir: pkgRoot
        }
      })
    }
  }
}
