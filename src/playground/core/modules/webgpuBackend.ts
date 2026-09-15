/**
 * Boots the WebGPU renderer for the playground and publishes its buffers so other modules
 * (memory harness, stress generator) can observe and drive it.
 *
 * Textures default to generated placeholders so a memory/stress run needs no asset
 * pipeline at all — which is the point: iOS crash testing should be one URL, not a full
 * world load.
 */

import * as THREE from 'three/webgpu'

import type { PlaygroundContext, PlaygroundModule } from '../types'
import { DocumentRendererGPU } from '../../../webgpu/documentRendererGPU'
import { detectWebGpuSupport } from '../../../webgpu/capabilities'

export type WebGpuBackendOptions = {
  atlas?: THREE.Texture
  tintPalette?: THREE.Texture
  canvas?: HTMLCanvasElement
  disableCulling?: boolean
  /** Opt in to non-full-block geometry (stairs, slabs, models). */
  enableLegacyGeometry?: boolean
}

/** 16x16-tile checkerboard atlas so faces are visibly distinct without real assets. */
function placeholderAtlas(tiles = 16): THREE.DataTexture {
  const size = tiles * 16
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const tileX = Math.floor(x / 16)
      const tileY = Math.floor(y / 16)
      const checker = ((x & 1) ^ (y & 1)) === 0 ? 255 : 180
      data[i] = (tileX * 37) % 256
      data[i + 1] = (tileY * 61) % 256
      data[i + 2] = checker
      data[i + 3] = 255
    }
  }
  const texture = new THREE.DataTexture(data, size, size)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.needsUpdate = true
  return texture
}

/** 256x1 palette; index 0 is white, matching the WebGL tint convention. */
function placeholderTintPalette(): THREE.DataTexture {
  const data = new Uint8Array(256 * 4).fill(255)
  const texture = new THREE.DataTexture(data, 256, 1)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.needsUpdate = true
  return texture
}

export function webgpuBackendModule(options: WebGpuBackendOptions = {}): PlaygroundModule {
  let renderer: DocumentRendererGPU | undefined
  let canvas: HTMLCanvasElement | undefined
  let onResize: (() => void) | undefined

  return {
    name: 'webgpuBackend',
    order: 20,

    async setup(ctx: PlaygroundContext) {
      const support = await detectWebGpuSupport()
      if (!support.supported) {
        ctx.log('webgpu.unavailable', { reason: support.reason })
        throw new Error(`WebGPU unavailable: ${support.reason}`)
      }

      canvas = options.canvas ?? document.createElement('canvas')
      if (!options.canvas) {
        Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%' })
        document.body.append(canvas)
      }

      renderer = await DocumentRendererGPU.create({
        canvas,
        atlas: options.atlas ?? placeholderAtlas(),
        tintPalette: options.tintPalette ?? placeholderTintPalette(),
        disableCulling: options.disableCulling,
        enableLegacyGeometry: options.enableLegacyGeometry
      })

      const applySize = () => {
        renderer?.setSize(globalThis.innerWidth, globalThis.innerHeight, Math.min(globalThis.devicePixelRatio || 1, 2))
      }
      applySize()
      onResize = applySize
      globalThis.addEventListener('resize', applySize, { passive: true })

      ctx.provide('gpuRenderer', renderer)
      ctx.provide('gpuBlocks', renderer.blocks)
      if (renderer.legacy) ctx.provide('gpuLegacy', renderer.legacy)
      ctx.log('webgpu.ready', {
        adapter: `${support.adapterInfo.vendor} ${support.adapterInfo.architecture}`,
        maxStorageBufferBindingSizeMB: support.limits.maxStorageBufferBindingSize / 1_048_576
      })
    },

    update() {
      // Driven from the runtime's frame loop rather than the renderer's own RAF, so all
      // modules observe exactly the same frame boundary.
      void renderer?.renderFrame()
    },

    teardown() {
      if (onResize) globalThis.removeEventListener('resize', onResize)
      renderer?.dispose()
      if (!options.canvas) canvas?.remove()
    }
  }
}

/**
 * Probe for the memory harness — reports the numbers that actually drive allocation.
 * Resolves the renderer per call, so it works even though the harness is set up first.
 */
export function gpuMemoryProbe(ctx: PlaygroundContext) {
  const renderer = ctx.get<DocumentRendererGPU>('gpuRenderer')
  if (!renderer) return {}
  const stats = renderer.stats
  return {
    // Includes the legacy buffers when enabled — they dominate memory when they are.
    bufferMB: (renderer.blocks.cpuBytes + (renderer.legacy?.cpuBytes ?? 0)) / 1_048_576,
    faces: stats.usedFaces,
    capacity: stats.capacityFaces,
    sections: stats.sectionCount,
    visible: stats.visibleFaces
  }
}
