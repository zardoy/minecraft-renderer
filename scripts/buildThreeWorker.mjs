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
  watch
})

if (watch) {
  const ctx = await context(buildOptions)
  await ctx.watch()
} else {
  await build(buildOptions)
}
