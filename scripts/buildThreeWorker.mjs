// @ts-check
import { context, build } from 'esbuild'
import path from 'path'
import { fileURLToPath } from 'url'
import { createWorkerBuildOptions } from './buildWorkerShared.mjs'
import { dynamicMcDataFiles } from '../src/lib/buildSharedConfig.mjs'

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)))
const rootDir = path.join(__dirname, '..')

const watch = process.argv.includes('-w')

// Three worker needs itemsArray and entitiesArray in addition to dynamicMcDataFiles
const threeWorkerMcData = [
  ...Object.keys(dynamicMcDataFiles),
  'itemsArray',
  'entitiesArray',
  'version'
]

const buildOptions = createWorkerBuildOptions({
  entryPoint: path.join(rootDir, './src/three/threeWorker.ts'),
  bundleMcData: threeWorkerMcData,
  watch,
  esbuildOptions: {
    sourcemap: watch,
    plugins: [
      {
        name: 'empty-mc-assets',
        setup(build) {
          // Handle main mc-assets module
          build.onResolve({
            filter: /^mc-assets$/,
          }, () => {
            return {
              path: 'mc-assets',
              namespace: 'empty-mc-assets'
            }
          })

          // Handle only JSON and PNG imports from mc-assets/dist/*
          build.onResolve({
            filter: /^mc-assets\/dist\/.*\.(json|png)$/,
          }, (args) => {
            return {
              path: args.path,
              namespace: 'empty-mc-assets'
            }
          })

          // Provide empty implementations only for JSON and PNG files
          build.onLoad({
            filter: /.*/,
            namespace: 'empty-mc-assets'
          }, (args) => {
            const path = args.path

            // Return appropriate empty values based on file type
            if (path.endsWith('.json')) {
              return {
                contents: 'export default {}',
                loader: 'js'
              }
            }

            if (path.endsWith('.png')) {
              return {
                contents: 'export default ""',
                loader: 'js'
              }
            }

            if (path === 'mc-assets') {
              return {
                contents: 'export function getLoadedItemDefinitionsStore() { return {} }; export class BlockModel {}',
                loader: 'js'
              }
            }

            // Default empty export for any other intercepted imports
            return {
              contents: 'export default {}',
              loader: 'js'
            }
          })
        }
      }
    ],
  }
})

if (watch) {
  const ctx = await context(buildOptions)
  await ctx.watch()
} else {
  await build(buildOptions)
}
