/**
 * Default backend: WebGPU when the device supports it, three.js/WebGL otherwise.
 *
 * This is the recommended entry point for library consumers. WebGPU is preferred because
 * it renders the world with compute-driven culling and indirect draws (see
 * `cullCompute.ts`), which removes the per-section main-thread work that dominates frame
 * time on mobile.
 *
 * The fallback is not optional politeness: WebGPU is still absent or disabled on a
 * meaningful share of browsers, and `detectWebGpuSupport()` also reports adapters that
 * exist but are software fallbacks. Those render correctly but slowly, so they are treated
 * as unsupported here and sent down the WebGL path.
 */

import type { GraphicsBackend, GraphicsBackendLoader, GraphicsInitOptions } from '../graphicsBackend'
import { detectWebGpuSupport } from './capabilities'
import { createGraphicsBackendWebGPU } from './graphicsBackendWebGPU'
import createGraphicsBackendSingleThread from '../three/graphicsBackendSingleThread'

export type AutoBackendChoice = {
  backend: 'webgpu' | 'threejs'
  reason: string
}

let lastChoice: AutoBackendChoice | undefined

/** What `createGraphicsBackendAuto` picked, once it has run. Useful for debug overlays. */
export function getAutoBackendChoice(): AutoBackendChoice | undefined {
  return lastChoice
}

/**
 * Resolves which backend would be used, without constructing one.
 * Exposed so an app can show the choice (or warn about a software adapter) up front.
 */
export async function resolveAutoBackend(): Promise<AutoBackendChoice> {
  const support = await detectWebGpuSupport()

  if (!support.supported) {
    return { backend: 'threejs', reason: support.reason }
  }
  if (support.isFallbackAdapter) {
    return { backend: 'threejs', reason: 'WebGPU reported a software fallback adapter; WebGL will be faster' }
  }
  return {
    backend: 'webgpu',
    reason: `WebGPU available (${support.adapterInfo.vendor} ${support.adapterInfo.architecture})`.trim()
  }
}

const createGraphicsBackendAuto: GraphicsBackendLoader = async (initOptions: GraphicsInitOptions): Promise<GraphicsBackend> => {
  const choice = await resolveAutoBackend()
  lastChoice = choice

  if (choice.backend === 'webgpu') {
    try {
      return await createGraphicsBackendWebGPU(initOptions)
    } catch (err: any) {
      // Adapter present but device creation or pipeline compilation failed — fall back
      // rather than leaving the app with no renderer at all.
      lastChoice = { backend: 'threejs', reason: `WebGPU init failed, fell back: ${err?.message ?? err}` }
      console.warn('[graphicsBackendAuto]', lastChoice.reason)
    }
  }

  return createGraphicsBackendSingleThread(initOptions)
}

createGraphicsBackendAuto.id = 'auto'
createGraphicsBackendAuto.displayName = 'Auto (WebGPU, WebGL fallback)'
createGraphicsBackendAuto.description = 'Prefers the GPU-driven WebGPU backend and falls back to three.js/WebGL when unavailable.'

export default createGraphicsBackendAuto
export { createGraphicsBackendAuto }
