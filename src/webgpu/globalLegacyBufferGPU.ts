/**
 * GPU-resident buffer for **non-full-block** geometry — stairs, slabs, fences, torches,
 * and every other model the mesher emits as indexed triangles. Opt-in; see
 * `DocumentRendererGPUOptions.enableLegacyGeometry`.
 *
 * The key observation is that this geometry is already **quad-based**: the WebGL
 * implementation stores 4 verts + 6 indices per quad, where the indices are a per-quad
 * corner template (`quadIndexTemplate`, values 0..3 relative to the quad's vertex base).
 *
 * That makes it the same shape as the cube path: **one quad = one instance of 6 vertices**,
 * with the 4 corners pulled from storage. Consequences:
 *
 *   - No index buffer on the GPU at all; corner selection is 2 bits per draw vertex.
 *   - `cullCompute` is reused **verbatim** — it compacts "N items belonging to a section",
 *     and a quad is just as valid an item as a face.
 *   - One more `drawIndirect`, so the whole world is 2 draws (cubes + everything else).
 *
 * Attributes are kept in separate buffers mirroring the mesher's arrays exactly, so
 * `addSection` is five `set()` memcpys with no repacking — the same main-thread win the
 * cube path gets. Packing colour/light to u8 would cut GPU memory ~40% but costs CPU per
 * vertex; deferred until the memory harness says it matters.
 */

import * as THREE from 'three/webgpu'
import { SECTION_META_STRIDE } from './globalBlockBufferGPU'

export const VERTS_PER_QUAD = 4
export const DRAW_VERTS_PER_QUAD = 6
export const FLOATS_PER_POS = 3
export const FLOATS_PER_UV = 2
export const FLOATS_PER_COLOR = 3

/** Bytes per vertex across all attribute buffers (pos 12 + uv 8 + colour 12 + 2 lights 8). */
export const BYTES_PER_VERTEX = 40

/** Bit position of the section-metadata index inside `quadMeta.y`. */
export const SECTION_INDEX_SHIFT = 12

const INITIAL_CAPACITY_QUADS = 128_000
const GROWTH_INCREMENT_QUADS = 256_000
const MAX_UPLOAD_QUADS_PER_FRAME = 8_000

/** Source geometry, identical to `LegacySectionGeometry` in the WebGL implementation. */
export type LegacySectionGeometry = {
  positions: Float32Array
  colors: Float32Array
  skyLights: Float32Array
  blockLights: Float32Array
  uvs: Float32Array
  indices: Uint32Array | Uint16Array
}

type Slot = { quadStart: number; quadCount: number; vertStart: number; vertCount: number; metaIndex: number }

export type GlobalLegacyBufferGPUOptions = {
  initialCapacityQuads?: number
  maxSections?: number
  maxCapacityQuads?: number
}

export class GlobalLegacyBufferGPU {
  positions: THREE.StorageBufferAttribute
  uvs: THREE.StorageBufferAttribute
  colors: THREE.StorageBufferAttribute
  skyLights: THREE.StorageBufferAttribute
  blockLights: THREE.StorageBufferAttribute

  /**
   * Per quad: (vertexBase, packed). `packed` holds the 6-entry corner template in bits
   * 0..11 (2 bits each) and the owning section's metadata index in bits 12..31 — the
   * vertex shader needs the section origin for the camera-relative transform, and 20 bits
   * covers `maxSections` many times over.
   */
  quadMeta: THREE.StorageBufferAttribute
  /** Same layout as the cube path's sectionMeta, so cullCompute can consume it. */
  sectionMeta: THREE.StorageBufferAttribute
  /** Compacted visible quad indices written by the cull pass. */
  visibleQuads: THREE.StorageBufferAttribute

  private capacityQuads: number
  private readonly maxCapacityQuads: number
  private readonly maxSections: number

  private positionsCpu: Float32Array
  private uvsCpu: Float32Array
  private colorsCpu: Float32Array
  private skyCpu: Float32Array
  private blockCpu: Float32Array
  private quadMetaCpu: Uint32Array
  private meta: Int32Array

  private readonly sectionSlots = new Map<string, Slot>()
  private freeList: Array<{ quadStart: number; quadCount: number }> = []
  private freeMetaIndices: number[] = []
  private metaHighWatermark = 0
  private quadHighWatermark = 0
  private dirty = false

  get sectionDispatchCount(): number {
    return this.metaHighWatermark
  }

  get usedQuads(): number {
    return this.quadHighWatermark
  }

  get capacity(): number {
    return this.capacityQuads
  }

  get sectionCount(): number {
    return this.sectionSlots.size
  }

  constructor(opts: GlobalLegacyBufferGPUOptions = {}) {
    this.capacityQuads = opts.initialCapacityQuads ?? INITIAL_CAPACITY_QUADS
    this.maxCapacityQuads = opts.maxCapacityQuads ?? Number.POSITIVE_INFINITY
    this.maxSections = opts.maxSections ?? 32_768

    const verts = this.capacityQuads * VERTS_PER_QUAD
    this.positionsCpu = new Float32Array(verts * FLOATS_PER_POS)
    this.uvsCpu = new Float32Array(verts * FLOATS_PER_UV)
    this.colorsCpu = new Float32Array(verts * FLOATS_PER_COLOR)
    this.skyCpu = new Float32Array(verts)
    this.blockCpu = new Float32Array(verts)
    this.quadMetaCpu = new Uint32Array(this.capacityQuads * 2)
    this.meta = new Int32Array(this.maxSections * SECTION_META_STRIDE)

    this.positions = new THREE.StorageBufferAttribute(this.positionsCpu, FLOATS_PER_POS)
    this.uvs = new THREE.StorageBufferAttribute(this.uvsCpu, FLOATS_PER_UV)
    this.colors = new THREE.StorageBufferAttribute(this.colorsCpu, FLOATS_PER_COLOR)
    this.skyLights = new THREE.StorageBufferAttribute(this.skyCpu, 1)
    this.blockLights = new THREE.StorageBufferAttribute(this.blockCpu, 1)
    this.quadMeta = new THREE.StorageBufferAttribute(this.quadMetaCpu, 2)
    this.sectionMeta = new THREE.StorageBufferAttribute(this.meta, SECTION_META_STRIDE)
    this.visibleQuads = new THREE.StorageBufferAttribute(new Uint32Array(this.capacityQuads), 1)
  }

  /** Packs the 6-entry corner template (2 bits each) plus the section index above it. */
  private static packQuad(indices: Uint32Array | Uint16Array, indexBase: number, localVertBase: number, sectionMetaIndex: number): number {
    let packed = 0
    for (let i = 0; i < DRAW_VERTS_PER_QUAD; i++) {
      const corner = (indices[indexBase + i] ?? 0) - localVertBase
      packed |= (corner & 0x3) << (i * 2)
    }
    packed |= (sectionMetaIndex & 0xf_ff_ff) << SECTION_INDEX_SHIFT
    return packed >>> 0
  }

  addSection(sectionKey: string, geo: LegacySectionGeometry, sx: number, sy: number, sz: number): boolean {
    const vertCount = geo.positions.length / FLOATS_PER_POS
    const quadCount = geo.indices.length / DRAW_VERTS_PER_QUAD

    if (!Number.isInteger(quadCount) || vertCount !== quadCount * VERTS_PER_QUAD) {
      // Non-quad topology isn't representable in this layout; skip rather than corrupt.
      return false
    }

    const existing = this.sectionSlots.get(sectionKey)
    if (existing) {
      if (existing.quadCount === quadCount) {
        this.writeGeometry(existing, geo, quadCount)
        this.writeMeta(existing.metaIndex, sx, sy, sz, existing.quadStart, quadCount)
        this.dirty = true
        return true
      }
      this.removeSection(sectionKey)
    }

    if (quadCount === 0) return true

    const alloc = this.allocate(quadCount)
    if (!alloc) return false

    const metaIndex = this.freeMetaIndices.pop() ?? this.metaHighWatermark++
    if (metaIndex >= this.maxSections) {
      this.release(alloc.quadStart, quadCount)
      return false
    }

    const slot: Slot = {
      quadStart: alloc.quadStart,
      quadCount,
      vertStart: alloc.quadStart * VERTS_PER_QUAD,
      vertCount: quadCount * VERTS_PER_QUAD,
      metaIndex
    }
    this.writeGeometry(slot, geo, quadCount)
    this.sectionSlots.set(sectionKey, slot)
    this.writeMeta(metaIndex, sx, sy, sz, slot.quadStart, quadCount)
    this.dirty = true
    return true
  }

  private writeGeometry(slot: Slot, geo: LegacySectionGeometry, quadCount: number): void {
    const vertBase = slot.vertStart
    this.positionsCpu.set(geo.positions, vertBase * FLOATS_PER_POS)
    this.uvsCpu.set(geo.uvs, vertBase * FLOATS_PER_UV)
    this.colorsCpu.set(geo.colors, vertBase * FLOATS_PER_COLOR)
    this.skyCpu.set(geo.skyLights, vertBase)
    this.blockCpu.set(geo.blockLights, vertBase)

    for (let q = 0; q < quadCount; q++) {
      const localVertBase = q * VERTS_PER_QUAD
      const o = (slot.quadStart + q) * 2
      this.quadMetaCpu[o] = vertBase + localVertBase
      this.quadMetaCpu[o + 1] = GlobalLegacyBufferGPU.packQuad(geo.indices, q * DRAW_VERTS_PER_QUAD, localVertBase, slot.metaIndex)
    }
  }

  removeSection(sectionKey: string): void {
    const slot = this.sectionSlots.get(sectionKey)
    if (!slot) return
    this.sectionSlots.delete(sectionKey)

    this.writeMeta(slot.metaIndex, 0, 0, 0, 0, 0)
    this.freeMetaIndices.push(slot.metaIndex)
    this.release(slot.quadStart, slot.quadCount)
    this.dirty = true
  }

  private writeMeta(metaIndex: number, sx: number, sy: number, sz: number, quadStart: number, quadCount: number): void {
    const o = metaIndex * SECTION_META_STRIDE
    this.meta[o] = sx
    this.meta[o + 1] = sy
    this.meta[o + 2] = sz
    this.meta[o + 3] = quadStart
    this.meta[o + 4] = quadCount
  }

  private allocate(count: number): { quadStart: number } | null {
    let bestIndex = -1
    for (const [i, block] of this.freeList.entries()) {
      if (block.quadCount === count) {
        bestIndex = i
        break
      }
      if (block.quadCount > count && bestIndex === -1) bestIndex = i
    }

    if (bestIndex !== -1) {
      const block = this.freeList[bestIndex]
      const quadStart = block.quadStart
      if (block.quadCount === count) this.freeList.splice(bestIndex, 1)
      else {
        block.quadStart += count
        block.quadCount -= count
      }
      return { quadStart }
    }

    if (this.quadHighWatermark + count > this.capacityQuads && !this.grow(count)) return null

    const quadStart = this.quadHighWatermark
    this.quadHighWatermark += count
    return { quadStart }
  }

  private release(quadStart: number, quadCount: number): void {
    this.freeList.push({ quadStart, quadCount })
    if (quadStart + quadCount === this.quadHighWatermark) {
      this.freeList.pop()
      this.quadHighWatermark = quadStart
      let changed = true
      while (changed) {
        changed = false
        for (const [i, b] of this.freeList.entries()) {
          if (b.quadStart + b.quadCount === this.quadHighWatermark) {
            this.quadHighWatermark = b.quadStart
            this.freeList.splice(i, 1)
            changed = true
            break
          }
        }
      }
    }
  }

  private grow(needed: number): boolean {
    let next = this.capacityQuads
    while (this.quadHighWatermark + needed > next) next += GROWTH_INCREMENT_QUADS
    if (next > this.maxCapacityQuads) return false

    const verts = next * VERTS_PER_QUAD
    const positions = new Float32Array(verts * FLOATS_PER_POS)
    const uvs = new Float32Array(verts * FLOATS_PER_UV)
    const colors = new Float32Array(verts * FLOATS_PER_COLOR)
    const sky = new Float32Array(verts)
    const block = new Float32Array(verts)
    const quadMeta = new Uint32Array(next * 2)

    positions.set(this.positionsCpu)
    uvs.set(this.uvsCpu)
    colors.set(this.colorsCpu)
    sky.set(this.skyCpu)
    block.set(this.blockCpu)
    quadMeta.set(this.quadMetaCpu)

    this.positionsCpu = positions
    this.uvsCpu = uvs
    this.colorsCpu = colors
    this.skyCpu = sky
    this.blockCpu = block
    this.quadMetaCpu = quadMeta
    this.capacityQuads = next

    this.positions = new THREE.StorageBufferAttribute(positions, FLOATS_PER_POS)
    this.uvs = new THREE.StorageBufferAttribute(uvs, FLOATS_PER_UV)
    this.colors = new THREE.StorageBufferAttribute(colors, FLOATS_PER_COLOR)
    this.skyLights = new THREE.StorageBufferAttribute(sky, 1)
    this.blockLights = new THREE.StorageBufferAttribute(block, 1)
    this.quadMeta = new THREE.StorageBufferAttribute(quadMeta, 2)
    this.visibleQuads = new THREE.StorageBufferAttribute(new Uint32Array(next), 1)
    return true
  }

  /** Uploads dirty attributes. Coarser than the cube path — legacy edits are rarer. */
  flushUploads(_maxQuads = MAX_UPLOAD_QUADS_PER_FRAME): boolean {
    if (!this.dirty) return false
    for (const attr of [this.positions, this.uvs, this.colors, this.skyLights, this.blockLights, this.quadMeta, this.sectionMeta]) {
      attr.needsUpdate = true
    }
    this.dirty = false
    return false
  }

  hasSection(sectionKey: string): boolean {
    return this.sectionSlots.has(sectionKey)
  }

  get fragmentation(): number {
    if (this.quadHighWatermark === 0) return 0
    return this.freeList.reduce((sum, b) => sum + b.quadCount, 0) / this.quadHighWatermark
  }

  /** CPU-side bytes — surfaced to the iOS memory harness. */
  get cpuBytes(): number {
    return (
      this.positionsCpu.byteLength +
      this.uvsCpu.byteLength +
      this.colorsCpu.byteLength +
      this.skyCpu.byteLength +
      this.blockCpu.byteLength +
      this.quadMetaCpu.byteLength +
      this.meta.byteLength
    )
  }

  dispose(): void {
    this.sectionSlots.clear()
    this.freeList = []
    this.freeMetaIndices = []
    this.quadHighWatermark = 0
    this.metaHighWatermark = 0
  }
}
