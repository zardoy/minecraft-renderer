/**
 * `WorldRendererCommon` implementation for the WebGPU backend.
 *
 * This is the piece that makes the backend actually usable: extending
 * `WorldRendererCommon` inherits chunk loading, mesher worker management, view distance,
 * player state and the whole `worldView` connection, so only the ~8 abstract members below
 * are WebGPU-specific.
 *
 * `outputFormat` is deliberately `'threeJs'`, not `'webgpu'`. The mesher's `'webgpu'` mode
 * changes the *legacy* geometry layout, whereas `GlobalLegacyBufferGPU` consumes the
 * threeJs shape (positions / colors / skyLights / blockLights / uvs / indices) and the
 * shader-cube words are identical either way. Switching it is a separate change with its
 * own verification.
 */

import * as THREE from 'three/webgpu'
import { Vec3 } from 'vec3'

import { WorldRendererCommon } from '../lib/worldrendererCommon'
import type { GraphicsInitOptions, DisplayWorldOptions } from '../graphicsBackend'
import type { UpdateCameraOptions } from '../graphicsBackend/types'
import { DocumentRendererGPU, type FrameStats } from './documentRendererGPU'
import type { GlobalLegacyBufferGPU } from './globalLegacyBufferGPU'

type GeometryMessage = {
  type: string
  key: string
  geometry: any
}

/** Section coords come with the geometry; fall back to the "x,y,z" message key. */
function sectionCoords(key: string, geometry: any): [number, number, number] {
  if (typeof geometry?.sx === 'number') return [geometry.sx, geometry.sy, geometry.sz]
  const parts = key.split(',').map(Number)
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

/** The worker may hand back plain arrays; the GPU buffers need typed arrays. */
const asF32 = (value: ArrayLike<number> | Float32Array | undefined): Float32Array =>
  value === undefined ? new Float32Array(0) : value instanceof Float32Array ? value : Float32Array.from(value)

const asU32 = (value: ArrayLike<number> | Uint32Array | Uint16Array | undefined): Uint32Array =>
  value === undefined ? new Uint32Array(0) : value instanceof Uint32Array ? value : Uint32Array.from(value as ArrayLike<number>)

/**
 * Uploads one section's indexed geometry into a quad buffer, or clears its slot when the
 * section has none. Shared by the opaque-legacy and blended passes — they differ only in
 * which buffer and material they target.
 */
function feedQuadBuffer(buffer: GlobalLegacyBufferGPU | undefined, key: string, geo: any, sx: number, sy: number, sz: number): void {
  if (!buffer) return

  if (!geo?.indices?.length) {
    buffer.removeSection(key)
    return
  }

  buffer.addSection(
    key,
    {
      positions: asF32(geo.positions),
      colors: asF32(geo.colors),
      skyLights: asF32(geo.skyLights),
      blockLights: asF32(geo.blockLights),
      uvs: asF32(geo.uvs),
      indices: asU32(geo.indices)
    },
    sx,
    sy,
    sz
  )
}

export class WorldRendererWebGPU extends WorldRendererCommon {
  outputFormat = 'threeJs' as const

  private readonly cameraWorldPos = new Vec3(0, 0, 0)
  private readonly _sectionOriginRel = new THREE.Vector3()
  private readonly _originDelta = new THREE.Vector3()
  private readonly _cameraOriginFrac = new THREE.Vector3()

  /** Sections whose geometry arrived before the renderer finished initialising. */
  private readonly pending = new Map<string, GeometryMessage>()

  constructor(
    public documentRenderer: DocumentRendererGPU,
    public initOptions: GraphicsInitOptions,
    public displayOptions: DisplayWorldOptions
  ) {
    if (!displayOptions.resourcesManager) throw new Error('resourcesManager is required in displayOptions')
    super(displayOptions.resourcesManager, displayOptions, initOptions)

    displayOptions.rendererState.renderer = this.documentRenderer.support?.supported
      ? `WebGPU (${this.documentRenderer.support.adapterInfo.vendor} ${this.documentRenderer.support.adapterInfo.architecture})`
      : 'WebGPU'

    for (const [key, message] of this.pending) this.handleWorkerMessage(message)
    this.pending.clear()
  }

  handleWorkerMessage(data: GeometryMessage): void {
    if (data.type !== 'geometry') return

    const { key, geometry } = data
    if (!geometry) return

    const [sx, sy, sz] = sectionCoords(key, geometry)
    const blocks = this.documentRenderer.blocks

    // --- full blocks (shader cubes) ---
    const shaderCubes = geometry.shaderCubes
    if (shaderCubes && shaderCubes.count > 0) {
      blocks.addSection(key, asU32(shaderCubes.words), shaderCubes.count, sx, sy, sz)
    } else {
      blocks.removeSection(key)
    }

    // --- everything else (opt-in) ---
    feedQuadBuffer(this.documentRenderer.legacy, key, geometry.geometry, sx, sy, sz)

    // --- blended geometry: water, glass, ice (opt-in) ---
    feedQuadBuffer(this.documentRenderer.blend, key, geometry.blendGeometry, sx, sy, sz)
  }

  updateCamera(pos: Vec3 | null, yaw: number, pitch: number, _options?: UpdateCameraOptions): void {
    if (pos) {
      this.cameraWorldPos.set(pos.x, pos.y, pos.z)

      // Split the world position into an integer section origin and a fractional
      // remainder, so float32 in the shaders never holds a raw world coordinate.
      const sxi = Math.floor(pos.x / 16)
      const syi = Math.floor(pos.y / 16)
      const szi = Math.floor(pos.z / 16)
      this._sectionOriginRel.set(sxi, syi, szi)
      this._originDelta.set(0, 0, 0)
      this._cameraOriginFrac.set(pos.x - sxi * 16, pos.y - syi * 16, pos.z - szi * 16)

      this.documentRenderer.setCameraOrigin(this._sectionOriginRel, this._originDelta, this._cameraOriginFrac)
      this.documentRenderer.camera.position.set(0, 0, 0)
    }

    this.documentRenderer.camera.rotation.set(pitch, yaw, 0, 'ZYX')
  }

  render(): void {
    void this.documentRenderer.renderFrame()
  }

  changeBackgroundColor(color: [number, number, number]): void {
    this.documentRenderer.scene.background = new THREE.Color(color[0], color[1], color[2])
  }

  changeCardinalLight(_cardinalLight: string): void {
    // Cardinal (nether) shading is a cube-shader uniform; wired when the nether theme is
    // ported. Left as a no-op so dimension switches don't throw.
  }

  updateShowChunksBorder(_value: boolean): void {
    // Chunk-border debug geometry is not ported to the WebGPU backend yet.
  }

  updatePlayerEntity(_e: any): void {
    // Entities are not rendered by this backend yet.
  }

  worldStop(): void {
    this.documentRenderer.blocks.dispose()
    this.documentRenderer.legacy?.dispose()
    this.documentRenderer.blend?.dispose()
  }

  get frameStats(): FrameStats {
    return this.documentRenderer.stats
  }
}
