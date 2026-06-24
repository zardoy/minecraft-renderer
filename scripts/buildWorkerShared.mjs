// @ts-check
import { polyfillNode } from 'esbuild-plugin-polyfill-node'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import { dynamicMcDataFiles } from '../src/lib/buildSharedConfig.mjs'
import { createEsbuildDataPlugin } from './esbuildDataPlugin.mjs'

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)))
const rootDir = path.join(__dirname, '..')

// Files that need to be dynamically loaded
const allowedBundleFiles = ['legacy', 'versions', 'protocolVersions', 'features']

/**
 * Creates the common plugin for handling minecraft-data JSON files and other externals
 * @param {string[]} bundleMcData - Array of mc-data file names to bundle
 * @param {string} rootDir - Root directory path
 */
export function createMcDataPlugin(bundleMcData, rootDir) {
  return {
    name: 'external-json',
    setup(build) {
      // Handle minecraft-data JSON files
      build.onResolve({ filter: /\.json$/ }, args => {
        const fileName = args.path.split('/').pop()?.replace('.json', '') ?? ''
        if (args.resolveDir.includes('minecraft-data')) {
          if (args.path.replaceAll('\\', '/').endsWith('bedrock/common/protocolVersions.json')) {
            return
          }
          if (args.path.includes('bedrock')) {
            return { path: args.path, namespace: 'empty-file' }
          }
          if (bundleMcData.includes(fileName)) {
            return {
              path: args.path,
              namespace: 'mc-data'
            }
          }
          if (!allowedBundleFiles.includes(fileName)) {
            return { path: args.path, namespace: 'empty-file' }
          }
        }
      })

      build.onResolve(
        {
          filter: /^zlib$/
        },
        ({ path }) => {
          return {
            path,
            namespace: 'empty-file'
          }
        }
      )

      build.onLoad(
        {
          filter: /.*/,
          namespace: 'empty-file'
        },
        () => {
          return { contents: 'module.exports = undefined', loader: 'js' }
        }
      )

      build.onLoad(
        {
          namespace: 'mc-data',
          filter: /.*/
        },
        async ({ path }) => {
          const fileName = path
            .split(/[\\\/]/)
            .pop()
            ?.replace('.json', '')
          return {
            contents: `module.exports = globalThis.mcData["${fileName}Array"] ?? globalThis.mcData["${fileName}"]`,
            loader: 'js',
            resolveDir: process.cwd()
          }
        }
      )

      build.onEnd(({ metafile, outputFiles }) => {
        if (!metafile) return
        fs.mkdirSync(path.join(rootDir, './dist'), { recursive: true })
        fs.writeFileSync(path.join(rootDir, './dist/metafile.json'), JSON.stringify(metafile))
        for (const outputFile of outputFiles ?? []) {
          const writePath = path.join(rootDir, './dist/', path.basename(outputFile.path))
          fs.mkdirSync(path.dirname(writePath), { recursive: true })
          fs.writeFileSync(writePath, outputFile.text)
        }
      })
    }
  }
}

/**
 * Creates base build options for worker builds
 * @param {object} options
 * @param {string} options.entryPoint - Entry point file path
 * @param {string[]} options.bundleMcData - Array of mc-data file names to bundle
 * @param {import('esbuild').BuildOptions} options.esbuildOptions - Custom esbuild options
 * @param {boolean} options.watch - Whether in watch mode
 */
export function createWorkerBuildOptions({ entryPoint, bundleMcData, watch, esbuildOptions }) {
  const BUNDLE_MC_DATA = bundleMcData || [...Object.keys(dynamicMcDataFiles), 'version']

  /** @type {import('esbuild').BuildOptions} */
  const buildOptions = {
    bundle: true,
    banner: {
      js: `globalThis.global = globalThis;process = {env: {}, versions: {} };`
    },
    platform: 'browser',
    entryPoints: [entryPoint],
    minify: !watch,
    minifyIdentifiers: false,
    logLevel: 'info',
    drop: !watch ? ['debugger'] : [],
    sourcemap: 'linked',
    target: watch ? undefined : ['ios14'],
    outdir: path.join(rootDir, './dist'),
    define: {
      'process.env.BROWSER': '"true"'
    },
    loader: {
      '.png': 'dataurl',
      '.obj': 'text'
    },
    ...esbuildOptions,
    plugins: [createMcDataPlugin(BUNDLE_MC_DATA, rootDir), createEsbuildDataPlugin(), polyfillNode(), ...(esbuildOptions.plugins ?? [])]
  }
  return buildOptions
}
