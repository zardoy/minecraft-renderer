/**
 * WebGPU graphics backend.
 *
 * Registers through the same `GraphicsBackendLoader` seam as the three.js backends
 * (`graphicsBackendSingleThread` / `graphicsBackendOffThread`), so it can be selected at
 * runtime without touching the WebGL path.
 *
 * Scope: the **shader-cube** geometry path — full blocks, which are the large majority of
 * world geometry. Legacy indexed-triangle geometry (stairs, slabs, models) is not ported
 * yet; sections carrying it will render their cube faces only. See `globalLegacyBuffer.ts`
 * for the WebGL implementation that still needs a GPU-driven equivalent.
 */

import { Vec3 } from 'vec3'
import * as THREE from 'three/webgpu'

import type { GraphicsBackend, GraphicsBackendLoader, GraphicsInitOptions, DisplayWorldOptions } from '../graphicsBackend'
import type { UpdateCameraOptions } from '../graphicsBackend/types'
import { DocumentRendererGPU } from './documentRendererGPU'
import { detectWebGpuSupport } from './capabilities'
import type { LegacySectionGeometry } from './globalLegacyBufferGPU'
import { WorldRendererWebGPU } from './worldRendererWebGPU'
import { getShaderCubeResources } from '../wasm-mesher/bridge/shaderCubeBridge'

/** Nearest-filtered, non-flipped atlas texture — matches the WebGL path's setup. */
function textureFromBitmap(bitmap: ImageBitmap): THREE.Texture {
  const texture = new THREE.Texture(bitmap as unknown as HTMLImageElement)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.flipY = false
  texture.needsUpdate = true
  return texture
}

/** Fallback palette (index 0 = white) for worlds whose resources carry no tint data. */
function whiteTintPalette(): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Uint8Array(256 * 4).fill(255), 256, 1)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.needsUpdate = true
  return texture
}

export type SectionGeometryUpdate = {
  sectionKey: string
  /** Interleaved uvec4 face words straight from the mesher. */
  words: Uint32Array
  count: number
  sx: number
  sy: number
  sz: number
}

class WebGPUBackend implements GraphicsBackend {
  id = 'webgpu'
  displayName = 'WebGPU (GPU-driven)'

  private documentRenderer: DocumentRendererGPU | undefined
  private worldRenderer: WorldRendererWebGPU | undefined
  private rendering = true
  private readonly canvas: HTMLCanvasElement

  constructor(
    private readonly initOptions: GraphicsInitOptions,
    canvas?: HTMLCanvasElement,
    /** Opt in to non-full-block geometry (stairs, slabs, models). */
    private readonly enableLegacyGeometry = false,
    /** Opt in to the blended pass (water, glass, ice). */
    private readonly enableTransparency = false
  ) {
    this.canvas = canvas ?? this.createCanvas()
  }

  private createCanvas(): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    canvas.id = 'webgpu-viewer-canvas'
    Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%' })
    document.body.append(canvas)
    return canvas
  }

  private readonly resize = (): void => {
    if (!this.documentRenderer) return
    const width = globalThis.innerWidth
    const height = globalThis.innerHeight
    this.documentRenderer.setSize(width, height, Math.min(globalThis.devicePixelRatio || 1, 2))
  }

  /** Feed mesher output. Mirrors chunkMeshManager's globalBlockBuffer.addSection call. */
  addSectionGeometry(update: SectionGeometryUpdate): boolean {
    const blocks = this.documentRenderer?.blocks
    if (!blocks) return false
    return blocks.addSection(update.sectionKey, update.words, update.count, update.sx, update.sy, update.sz)
  }

  removeSectionGeometry(sectionKey: string): void {
    this.documentRenderer?.blocks.removeSection(sectionKey)
    this.documentRenderer?.legacy?.removeSection(sectionKey)
  }

  /**
   * Feed non-full-block geometry. Mirrors chunkMeshManager's
   * `getGlobalLegacyBuffer().addSection(...)` call. No-op unless the backend was
   * initialised with `enableLegacyGeometry`.
   */
  addLegacySectionGeometry(sectionKey: string, geo: LegacySectionGeometry, sx: number, sy: number, sz: number): boolean {
    const legacy = this.documentRenderer?.legacy
    if (!legacy) return false
    return legacy.addSection(sectionKey, geo, sx, sy, sz)
  }

  get supportsLegacyGeometry(): boolean {
    return this.documentRenderer?.legacy !== undefined
  }

  async startMenuBackground(): Promise<void> {
    // The menu background is a three.js WebGL scene; the WebGPU backend renders the world
    // only. Left as a no-op so backend switching doesn't crash on the menu.
  }

  /**
   * Builds the renderer from the world's resources and connects it to the world view.
   *
   * The atlas only exists once `resourcesManager` has loaded, which is why initialisation
   * happens here rather than in the loader — the loader has no resources to work with.
   */
  async startWorld(options: DisplayWorldOptions): Promise<void> {
    const resources = options.resourcesManager.currentResources
    if (!resources?.blocksAtlasImage) {
      throw new Error('WebGPU backend: resourcesManager has no blocksAtlasImage')
    }

    const atlas = textureFromBitmap(resources.blocksAtlasImage)

    // The tint palette is built by the shader-cube bridge during meshing, not carried on
    // the transferred resources. Mirror the WebGL path's lazy `createTexture()` so both
    // backends render from the same palette; fall back to white before meshing has run.
    const palette = getShaderCubeResources()?.tintPalette
    if (palette && !palette.isReady()) palette.createTexture()
    const tintPalette = (palette?.getTexture() as unknown as THREE.Texture | null) ?? whiteTintPalette()

    this.documentRenderer = await DocumentRendererGPU.create({
      canvas: this.canvas,
      atlas,
      tintPalette,
      enableLegacyGeometry: this.enableLegacyGeometry,
      enableTransparency: this.enableTransparency
    })
    this.resize()
    globalThis.addEventListener('resize', this.resize, { passive: true })

    // WorldRendererCommon connects itself to the world view and owns the mesher workers.
    this.worldRenderer = new WorldRendererWebGPU(this.documentRenderer, this.initOptions, options)

    this.documentRenderer.setSkyLevel(1)
    this.documentRenderer.setFog(null)

    this.documentRenderer.startLoop(() => {
      this.worldRenderer?.render()
    })
  }

  updateCamera(pos: Vec3 | null, yaw: number, pitch: number, options?: UpdateCameraOptions): void {
    this.worldRenderer?.updateCamera(pos, yaw, pitch, options)
  }

  setRendering(rendering: boolean): void {
    if (rendering === this.rendering) return
    this.rendering = rendering
    if (rendering) this.documentRenderer?.startLoop()
    else this.documentRenderer?.stopLoop()
  }

  getDebugOverlay(): { left?: Record<string, string>; right?: Record<string, string> } {
    const dr = this.documentRenderer
    if (!dr) return {}
    const s = dr.stats
    return {
      left: {
        backend: 'WebGPU (GPU-driven)',
        adapter: dr.support?.supported ? `${dr.support.adapterInfo.vendor} ${dr.support.adapterInfo.architecture}` : 'unknown',
        visibleFaces: s.visibleFaces.toLocaleString(),
        usedFaces: `${s.usedFaces.toLocaleString()} / ${s.capacityFaces.toLocaleString()}`,
        sections: String(s.sectionCount),
        cpuFrame: `${s.cpuFrameMs.toFixed(2)} ms`,
        uploads: s.uploadsPending ? 'pending' : 'idle',
        legacy: s.legacy ? `${s.legacy.visibleQuads.toLocaleString()} quads / ${s.legacy.sectionCount} sections` : 'disabled',
        transparent: s.blend ? `${s.blend.visibleQuads.toLocaleString()} quads / ${s.blend.sectionCount} sections` : 'disabled'
      }
    }
  }

  disconnect(): void {
    globalThis.removeEventListener('resize', this.resize)
    this.worldRenderer?.worldStop()
    this.worldRenderer = undefined
    this.documentRenderer?.dispose()
    this.documentRenderer = undefined
    this.canvas.remove()
  }
}

const createGraphicsBackendWebGPU: GraphicsBackendLoader = async (initOptions: GraphicsInitOptions): Promise<GraphicsBackend> => {
  const support = await detectWebGpuSupport()
  if (!support.supported) {
    const error = new Error(`WebGPU backend unavailable: ${support.reason}`)
    initOptions.callbacks.displayCriticalError(error)
    throw error
  }
  // Opt in to non-full-block geometry via rendererSpecificSettings:
  //   viewer.loadBackend(createGraphicsBackendWebGPU)  // cubes only (default)
  //   ... rendererSpecificSettings: { enableLegacyGeometry: true }
  const settings = initOptions.rendererSpecificSettings as any
  return new WebGPUBackend(initOptions, undefined, Boolean(settings?.enableLegacyGeometry), Boolean(settings?.enableTransparency))
}

createGraphicsBackendWebGPU.id = 'webgpu'
createGraphicsBackendWebGPU.displayName = 'WebGPU (GPU-driven)'
createGraphicsBackendWebGPU.description = 'Compute-culled world geometry rendered as a single indirect draw. Requires WebGPU.'

export default createGraphicsBackendWebGPU
export { createGraphicsBackendWebGPU, WebGPUBackend }
