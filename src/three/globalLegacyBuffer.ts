import * as THREE from 'three'
import {
  createLegacyMultiDrawScratch,
  detectLegacyMultiDrawCaps,
  drawLegacySpans,
  logLegacyMultiDrawTierOnce,
  type LegacyDrawSpan,
  type LegacyMultiDrawCaps,
  type LegacyMultiDrawScratch
} from './legacyMultiDraw'
import { computeCameraRelativeUniforms, type RenderOrigin } from './shaders/legacyBlockShader'

const VERTS_PER_QUAD = 4
const INDICES_PER_QUAD = 6
const FLOATS_PER_VERT = 3
const FLOATS_PER_UV_VERT = 2
const FLOATS_PER_LIGHT_VERT = 1

const DEFAULT_INITIAL_CAPACITY_QUADS = 128_000
const DEFAULT_GROWTH_INCREMENT_QUADS = 128_000
const MAX_UPLOAD_QUADS_PER_FRAME = 5_000
const FRAGMENTATION_THRESHOLD = 0.25

type PendingMove = { key: string; oldStart: number; newStart: number; count: number }
type PendingReplace = { oldStart: number; oldCount: number }

/** CPU bytes per allocated quad slot (all legacy vertex/index attrs). */
export const LEGACY_BYTES_PER_QUAD = VERTS_PER_QUAD * (FLOATS_PER_VERT * 3 + FLOATS_PER_LIGHT_VERT * 2 + FLOATS_PER_UV_VERT) * 4 + INDICES_PER_QUAD * 4

export const FULL_DRAW_VISIBLE_FRACTION = 0.75
/** Initial multi_draw scratch size; arrays auto-grow — not a draw-call cap. */
export const MAX_OPAQUE_SPANS = 64

/** Dev assert: every quad in draw spans must lie in a live section's drawable range. */
export function assertDrawSpansWithinLiveRanges(
  spans: ReadonlyArray<{ start: number; count: number }>,
  liveRanges: ReadonlyArray<{ start: number; count: number }>,
  bufferName: string
): void {
  for (const span of spans) {
    for (let q = span.start; q < span.start + span.count; q++) {
      let inLive = false
      for (const live of liveRanges) {
        if (q >= live.start && q < live.start + live.count) {
          inLive = true
          break
        }
      }
      if (!inLive) {
        console.error('[GlobalLegacyBuffer] draw span covers non-live quad', {
          buffer: bufferName,
          quad: q,
          span,
          liveRanges
        })
      }
    }
  }
}

export type DirtyRange = { start: number; end: number }

/** Split draw spans to exclude quad/face ranges still in pendingRanges (not yet on GPU). */
export function carveSpansAroundPendingRanges(
  spans: Array<{ start: number; count: number }>,
  pendingRanges: ReadonlyArray<DirtyRange>
): Array<{ start: number; count: number }> {
  if (pendingRanges.length === 0) return spans
  const out: Array<{ start: number; count: number }> = []
  for (const span of spans) {
    let segments: Array<{ start: number; count: number }> = [span]
    for (const pr of pendingRanges) {
      const next: Array<{ start: number; count: number }> = []
      for (const seg of segments) {
        const segEnd = seg.start + seg.count - 1
        if (pr.end < seg.start || pr.start > segEnd) {
          next.push(seg)
          continue
        }
        if (pr.start > seg.start) {
          next.push({ start: seg.start, count: pr.start - seg.start })
        }
        if (pr.end < segEnd) {
          next.push({ start: pr.end + 1, count: segEnd - pr.end })
        }
      }
      segments = next
    }
    out.push(...segments)
  }
  return out.filter(s => s.count > 0)
}

export type GlobalLegacyBufferOptions = {
  name?: string
  initialCapacityQuads?: number
  growthIncrementQuads?: number
}

export type VisibleSectionSpan = { key: string; distSq: number }

export type LegacySectionGeometry = {
  positions: Float32Array
  colors: Float32Array
  skyLights: Float32Array
  blockLights: Float32Array
  uvs: Float32Array
  indices: Uint32Array | Uint16Array
}

export type LegacySectionGeometryData = LegacySectionGeometry & {
  sx: number
  sy: number
  sz: number
}

export type { LegacyDrawSpan } from './legacyMultiDraw'

/**
 * Single GPU mesh for legacy quads (opaque+cutout or transparent blend).
 * Camera-relative via per-vertex a_origin (relative to render origin) + u_originDelta uniforms.
 */
export class GlobalLegacyBuffer {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial | THREE.ShaderMaterial[]>
  readonly material: THREE.ShaderMaterial

  private readonly growthIncrementQuads: number
  private capacityQuads: number
  private positions: Float32Array
  private colors: Float32Array
  private skyLights: Float32Array
  private blockLights: Float32Array
  private uvs: Float32Array
  private aOrigin: Float32Array
  private indices: Uint32Array
  /** Section-relative world centroid per physical quad (3 floats each). */
  private quadCentroids: Float32Array
  /** Per-quad local index template (6 bytes each, values 0..3). */
  private quadIndexTemplate: Uint8Array
  private readonly sectionSlots = new Map<string, { start: number; count: number }>()
  private freeList: Array<{ start: number; count: number }> = []
  private highWatermark = 0
  private pendingRanges: Array<{ start: number; end: number }> = []
  private indexPendingRanges: Array<{ start: number; end: number }> = []
  private readonly _spanScratch: Array<{ start: number; count: number }> = []
  private renderOrigin: RenderOrigin = { x: 0, y: 0, z: 0 }
  private layoutVersion = 0
  private pendingMove: PendingMove | null = null
  private readonly pendingReplace = new Map<string, PendingReplace>()
  private uploadEpoch = 0
  private visibleIndexSpans: LegacyDrawSpan[] = []
  private readonly _drawScratch: LegacyMultiDrawScratch = createLegacyMultiDrawScratch()
  private multiDrawCaps: LegacyMultiDrawCaps | null = null
  private debugOverlay = false

  constructor(material: THREE.ShaderMaterial, scene: THREE.Object3D, opts?: GlobalLegacyBufferOptions) {
    this.material = material
    this.growthIncrementQuads = opts?.growthIncrementQuads ?? DEFAULT_GROWTH_INCREMENT_QUADS
    this.capacityQuads = opts?.initialCapacityQuads ?? DEFAULT_INITIAL_CAPACITY_QUADS
    const maxVerts = this.capacityQuads * VERTS_PER_QUAD
    this.positions = new Float32Array(maxVerts * FLOATS_PER_VERT)
    this.colors = new Float32Array(maxVerts * FLOATS_PER_VERT)
    this.skyLights = new Float32Array(maxVerts * FLOATS_PER_LIGHT_VERT)
    this.blockLights = new Float32Array(maxVerts * FLOATS_PER_LIGHT_VERT)
    this.uvs = new Float32Array(maxVerts * FLOATS_PER_UV_VERT)
    this.aOrigin = new Float32Array(maxVerts * FLOATS_PER_VERT)
    this.indices = new Uint32Array(this.capacityQuads * INDICES_PER_QUAD)
    this.quadCentroids = new Float32Array(this.capacityQuads * 3)
    this.quadIndexTemplate = new Uint8Array(this.capacityQuads * INDICES_PER_QUAD)

    const geometry = new THREE.BufferGeometry()
    const mkAttr = (arr: Float32Array, itemSize: number, name: string) => {
      const attr = new THREE.BufferAttribute(arr, itemSize)
      attr.setUsage(THREE.DynamicDrawUsage)
      geometry.setAttribute(name, attr)
      return attr
    }
    mkAttr(this.positions, FLOATS_PER_VERT, 'position')
    mkAttr(this.colors, FLOATS_PER_VERT, 'color')
    mkAttr(this.skyLights, FLOATS_PER_LIGHT_VERT, 'a_skyLight')
    mkAttr(this.blockLights, FLOATS_PER_LIGHT_VERT, 'a_blockLight')
    mkAttr(this.uvs, FLOATS_PER_UV_VERT, 'uv')
    mkAttr(this.aOrigin, FLOATS_PER_VERT, 'a_origin')

    const indexAttr = new THREE.BufferAttribute(this.indices, 1)
    indexAttr.setUsage(THREE.DynamicDrawUsage)
    geometry.setIndex(indexAttr)

    geometry.setDrawRange(0, 0)
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity)

    this.mesh = new THREE.Mesh(geometry, [material])
    this.mesh.name = opts?.name ?? 'globalLegacyOpaque'
    this.mesh.frustumCulled = false
    this.mesh.matrixAutoUpdate = false
    this.mesh.matrix.identity()
    this.mesh.position.set(0, 0, 0)
    scene.add(this.mesh)
    this.syncDefaultDrawGroups()

    this.mesh.onAfterRender = (renderer, _scene, _camera, _geometry, material) => {
      if (this.visibleIndexSpans.length === 0) return
      const gl = renderer.getContext() as WebGL2RenderingContext
      if (!this.multiDrawCaps) {
        this.multiDrawCaps = detectLegacyMultiDrawCaps(gl)
        logLegacyMultiDrawTierOnce(this.multiDrawCaps.tier, this.debugOverlay)
      }
      drawLegacySpans(gl, this.multiDrawCaps, this.visibleIndexSpans, this._drawScratch)
    }
  }

  setDebugOverlay(enabled: boolean): void {
    this.debugOverlay = enabled
  }

  /**
   * Suppress three's full-buffer indexed draw; onAfterRender issues visible spans only.
   * setDrawRange(0,0) skips bindingStates.setup — use a minimal non-zero range so
   * program/VAO/ELEMENT_ARRAY_BUFFER stay bound while three draws ~nothing.
   * Draws one triangle from index 0 (usually harmless; if quad 0 is culled, one stray tri).
   */
  suppressThreeDraw(): void {
    this.mesh.geometry.setDrawRange(0, 3)
  }

  setVisibleIndexSpans(spans: LegacyDrawSpan[]): void {
    this.visibleIndexSpans = spans
  }

  getVisibleIndexSpans(): readonly LegacyDrawSpan[] {
    return this.visibleIndexSpans
  }

  private syncDefaultDrawGroups(): void {
    const geometry = this.mesh.geometry
    geometry.clearGroups()
    const indexCount = this.highWatermark * INDICES_PER_QUAD
    if (indexCount > 0) {
      geometry.addGroup(0, indexCount, 0)
    }
    geometry.setDrawRange(0, indexCount)
  }

  addSection(sectionKey: string, geo: LegacySectionGeometry, sx: number, sy: number, sz: number): boolean {
    const vertCount = geo.positions.length / FLOATS_PER_VERT
    const quadCount = vertCount / VERTS_PER_QUAD
    if (vertCount === 0 || quadCount * VERTS_PER_QUAD !== vertCount) {
      this.removeSection(sectionKey)
      return false
    }
    if (geo.indices.length % INDICES_PER_QUAD !== 0 || geo.indices.length / INDICES_PER_QUAD !== quadCount) {
      return false
    }

    const isRemesh = this.sectionSlots.has(sectionKey)
    let previousSlot: { start: number; count: number } | undefined
    if (isRemesh) {
      const currentSlot = this.sectionSlots.get(sectionKey)!
      const inflightReplace = this.pendingReplace.get(sectionKey)
      const inflightMove = this.pendingMove?.key === sectionKey ? this.pendingMove : undefined
      if (inflightReplace) {
        this.zeroAndFreeSlot(currentSlot.start, currentSlot.count)
        previousSlot = { start: inflightReplace.oldStart, count: inflightReplace.oldCount }
        this.pendingReplace.delete(sectionKey)
      } else if (inflightMove) {
        this.zeroAndFreeSlot(currentSlot.start, currentSlot.count)
        previousSlot = { start: inflightMove.oldStart, count: inflightMove.count }
        this.pendingMove = null
      } else {
        previousSlot = currentSlot
      }
    }

    if (quadCount > this.capacityQuads) {
      this.growCapacity(quadCount)
    }

    let slot = this.takeFreeSlot(quadCount)
    if (!slot) {
      if (this.highWatermark + quadCount > this.capacityQuads) {
        this.growCapacity(this.highWatermark + quadCount)
      }
      slot = { start: this.highWatermark, count: quadCount }
      this.highWatermark += quadCount
    }

    const dstVertBase = slot.start * VERTS_PER_QUAD
    const dstFloatBase = dstVertBase * FLOATS_PER_VERT
    const dstUvBase = dstVertBase * FLOATS_PER_UV_VERT
    const dstLightBase = dstVertBase * FLOATS_PER_LIGHT_VERT
    this.positions.set(geo.positions, dstFloatBase)
    this.colors.set(geo.colors, dstFloatBase)
    this.skyLights.set(geo.skyLights, dstLightBase)
    this.blockLights.set(geo.blockLights, dstLightBase)
    this.uvs.set(geo.uvs, dstUvBase)

    const originOff = dstFloatBase
    const ox = sx - this.renderOrigin.x
    const oy = sy - this.renderOrigin.y
    const oz = sz - this.renderOrigin.z
    for (let v = 0; v < vertCount; v++) {
      const o = originOff + v * FLOATS_PER_VERT
      this.aOrigin[o] = ox
      this.aOrigin[o + 1] = oy
      this.aOrigin[o + 2] = oz
    }

    const dstIndexBase = slot.start * INDICES_PER_QUAD
    const vertexBase = dstVertBase
    for (let i = 0; i < geo.indices.length; i++) {
      this.indices[dstIndexBase + i] = geo.indices[i]! + vertexBase
    }

    for (let q = 0; q < quadCount; q++) {
      const physQuad = slot.start + q
      const localVertBase = q * VERTS_PER_QUAD
      const posBase = localVertBase * FLOATS_PER_VERT
      let cx = 0
      let cy = 0
      let cz = 0
      for (let v = 0; v < VERTS_PER_QUAD; v++) {
        const p = posBase + v * FLOATS_PER_VERT
        cx += geo.positions[p]!
        cy += geo.positions[p + 1]!
        cz += geo.positions[p + 2]!
      }
      const centBase = physQuad * 3
      this.quadCentroids[centBase] = cx / VERTS_PER_QUAD
      this.quadCentroids[centBase + 1] = cy / VERTS_PER_QUAD
      this.quadCentroids[centBase + 2] = cz / VERTS_PER_QUAD

      const idxBase = q * INDICES_PER_QUAD
      const tmplBase = physQuad * INDICES_PER_QUAD
      for (let i = 0; i < INDICES_PER_QUAD; i++) {
        this.quadIndexTemplate[tmplBase + i] = geo.indices[idxBase + i]! - localVertBase
      }
    }

    this.sectionSlots.set(sectionKey, slot)
    if (isRemesh && previousSlot) {
      this.pendingReplace.set(sectionKey, { oldStart: previousSlot.start, oldCount: previousSlot.count })
    }
    this.markDirty(slot.start, slot.start + quadCount - 1)
    this.syncDefaultDrawGroups()
    this.layoutVersion++
    return true
  }

  getLayoutVersion(): number {
    return this.layoutVersion
  }

  getUploadEpoch(): number {
    return this.uploadEpoch
  }

  hasPendingReplace(): boolean {
    return this.pendingReplace.size > 0
  }

  canUseFullDrawShortcut(): boolean {
    return this.pendingRanges.length === 0 && this.interiorFreeQuads() === 0 && this.pendingMove === null && this.pendingReplace.size === 0
  }

  isRangeFullyUploaded(start: number, end: number): boolean {
    return this.rangeFullyUploaded(start, end)
  }

  getPendingDirtyRanges(): ReadonlyArray<DirtyRange> {
    return this.pendingRanges
  }

  getSectionDrawStart(sectionKey: string): number | undefined {
    const slot = this.sectionSlots.get(sectionKey)
    if (!slot) return undefined
    if (this.pendingMove?.key === sectionKey) return this.pendingMove.oldStart
    const replace = this.pendingReplace.get(sectionKey)
    if (replace) return replace.oldStart
    if (!this.rangeFullyUploaded(slot.start, slot.start + slot.count - 1)) return undefined
    return slot.start
  }

  getSectionDrawCount(sectionKey: string): number | undefined {
    const slot = this.sectionSlots.get(sectionKey)
    if (!slot) return undefined
    if (this.pendingMove?.key === sectionKey) return this.pendingMove.count
    const replace = this.pendingReplace.get(sectionKey)
    if (replace) return replace.oldCount
    if (!this.rangeFullyUploaded(slot.start, slot.start + slot.count - 1)) return undefined
    return slot.count
  }

  getPendingMove(): PendingMove | null {
    return this.pendingMove
  }

  /** One interior-hole move per frame when fragmentation exceeds threshold; deferred shrink. */
  compactStep(): void {
    if (this.pendingMove) {
      const { newStart, count } = this.pendingMove
      if (this.rangeFullyUploaded(newStart, newStart + count - 1)) {
        this.finalizePendingMove()
      }
      return
    }

    for (const key of [...this.pendingReplace.keys()]) {
      const slot = this.sectionSlots.get(key)
      if (!slot) continue
      if (this.rangeFullyUploaded(slot.start, slot.start + slot.count - 1)) {
        this.finalizePendingReplace(key)
      }
    }

    if (this.highWatermark === 0) return
    const interiorFree = this.interiorFreeQuads()
    if (interiorFree / this.highWatermark <= FRAGMENTATION_THRESHOLD) return

    const section = this.findMovableSection(MAX_UPLOAD_QUADS_PER_FRAME)
    if (!section) return

    const hole = this.findLowestInteriorHole(section.start, section.count)
    if (!hole) return

    const reserved = this.reserveFreeSlotAt(hole.index, section.count)
    const oldStart = section.start
    const newStart = reserved.start

    this.copySectionRange(oldStart, newStart, section.count)
    this.sectionSlots.set(section.key, { start: newStart, count: section.count })
    this.markDirty(newStart, newStart + section.count - 1)
    this.pendingMove = { key: section.key, oldStart, newStart, count: section.count }
    this.layoutVersion++
  }

  updateDrawSpans(visible: VisibleSectionSpan[], mode: 'opaque' | 'sortedBlend'): void {
    this.visibleIndexSpans = []

    if (this.highWatermark === 0) {
      return
    }

    const spans = this._spanScratch
    spans.length = 0
    let visibleQuadCount = 0

    for (const entry of visible) {
      const drawStart = this.getSectionDrawStart(entry.key)
      const drawCount = this.getSectionDrawCount(entry.key)
      const slot = this.sectionSlots.get(entry.key)
      if (drawStart === undefined || drawCount === undefined || !slot) continue
      spans.push({ start: drawStart, count: drawCount })
      visibleQuadCount += drawCount
    }

    if (spans.length === 0) {
      return
    }

    const pushIndexSpan = (quadStart: number, quadCount: number): void => {
      this.visibleIndexSpans.push({
        indexStart: quadStart * INDICES_PER_QUAD,
        indexCount: quadCount * INDICES_PER_QUAD
      })
    }

    if (mode === 'opaque') {
      let finalQuads: Array<{ start: number; count: number }>
      const liveDrawRanges = spans.map(s => ({ ...s }))
      const usedFullDraw = this.canUseFullDrawShortcut() && visibleQuadCount >= this.highWatermark * FULL_DRAW_VISIBLE_FRACTION
      if (usedFullDraw) {
        finalQuads = [{ start: 0, count: this.highWatermark }]
      } else {
        spans.sort((a, b) => a.start - b.start)
        this.mergeOpaqueSpans(spans)
        finalQuads = spans
      }
      finalQuads = carveSpansAroundPendingRanges(finalQuads, this.pendingRanges)
      if (!usedFullDraw) {
        assertDrawSpansWithinLiveRanges(finalQuads, liveDrawRanges, this.mesh.name)
      }
      for (const span of finalQuads) {
        pushIndexSpan(span.start, span.count)
      }
    } else {
      visible.sort((a, b) => b.distSq - a.distSq)
      for (const entry of visible) {
        const drawStart = this.getSectionDrawStart(entry.key)
        const drawCount = this.getSectionDrawCount(entry.key)
        if (drawStart === undefined || drawCount === undefined) continue
        pushIndexSpan(drawStart, drawCount)
      }
    }
  }

  /** Merge only physically adjacent section slots (gap === 0). Never bridge interior holes. */
  private mergeOpaqueSpans(spans: Array<{ start: number; count: number }>): void {
    if (spans.length < 2) return
    let i = 0
    while (i < spans.length - 1) {
      const cur = spans[i]!
      const next = spans[i + 1]!
      if (cur.start + cur.count === next.start) {
        cur.count = next.start + next.count - cur.start
        spans.splice(i + 1, 1)
      } else {
        i++
      }
    }
  }

  hasSection(sectionKey: string): boolean {
    return this.sectionSlots.has(sectionKey)
  }

  getSectionSlot(sectionKey: string): { start: number; count: number } | undefined {
    return this.sectionSlots.get(sectionKey)
  }

  takeSectionData(sectionKey: string): LegacySectionGeometryData | undefined {
    const data = this.getSectionGeometryData(sectionKey)
    if (!data) return undefined
    this.removeSection(sectionKey)
    return data
  }

  getSectionGeometryData(sectionKey: string): LegacySectionGeometryData | undefined {
    const slot = this.sectionSlots.get(sectionKey)
    if (!slot) return undefined

    const vertCount = slot.count * VERTS_PER_QUAD
    const dstVertBase = slot.start * VERTS_PER_QUAD
    const dstFloatBase = dstVertBase * FLOATS_PER_VERT
    const dstUvBase = dstVertBase * FLOATS_PER_UV_VERT
    const dstIndexBase = slot.start * INDICES_PER_QUAD
    const indexLen = slot.count * INDICES_PER_QUAD

    const dstLightBase = dstVertBase * FLOATS_PER_LIGHT_VERT

    const positions = this.positions.slice(dstFloatBase, dstFloatBase + vertCount * FLOATS_PER_VERT)
    const colors = this.colors.slice(dstFloatBase, dstFloatBase + vertCount * FLOATS_PER_VERT)
    const skyLights = this.skyLights.slice(dstLightBase, dstLightBase + vertCount * FLOATS_PER_LIGHT_VERT)
    const blockLights = this.blockLights.slice(dstLightBase, dstLightBase + vertCount * FLOATS_PER_LIGHT_VERT)
    const uvs = this.uvs.slice(dstUvBase, dstUvBase + vertCount * FLOATS_PER_UV_VERT)
    const indices = this.indices.slice(dstIndexBase, dstIndexBase + indexLen)
    const vertexBase = dstVertBase
    for (let i = 0; i < indices.length; i++) {
      indices[i] = indices[i]! - vertexBase
    }

    const sx = this.aOrigin[dstFloatBase]! + this.renderOrigin.x
    const sy = this.aOrigin[dstFloatBase + 1]! + this.renderOrigin.y
    const sz = this.aOrigin[dstFloatBase + 2]! + this.renderOrigin.z

    return { positions, colors, skyLights, blockLights, uvs, indices, sx, sy, sz }
  }

  removeSection(sectionKey: string): void {
    const slot = this.sectionSlots.get(sectionKey)
    if (!slot) return

    if (this.pendingReplace.has(sectionKey)) {
      const pr = this.pendingReplace.get(sectionKey)!
      this.zeroAndFreeSlot(pr.oldStart, pr.oldCount)
      this.pendingReplace.delete(sectionKey)
    }

    if (this.pendingMove?.key === sectionKey) {
      const { oldStart, count } = this.pendingMove
      this.zeroAndFreeSlot(oldStart, count)
      this.pendingMove = null
    }

    const dstIndexBase = slot.start * INDICES_PER_QUAD
    const indexLen = slot.count * INDICES_PER_QUAD
    for (let i = 0; i < indexLen; i++) {
      this.indices[dstIndexBase + i] = 0
    }

    this.markDirty(slot.start, slot.start + slot.count - 1)
    this.sectionSlots.delete(sectionKey)
    this.insertFreeSlot(slot)
    this.shrinkHighWatermark()
    this.syncDefaultDrawGroups()
    this.layoutVersion++
  }

  hasPendingUploads(): boolean {
    return this.pendingRanges.length > 0
  }

  hasPendingIndexUploads(): boolean {
    return this.indexPendingRanges.length > 0
  }

  /**
   * Reorder a section's index buffer back-to-front by quad centroid distance to camera.
   * Does not bump layoutVersion or uploadEpoch (draw spans unchanged).
   */
  reorderSectionBlendIndices(sectionKey: string, camX: number, camY: number, camZ: number): boolean {
    const slot = this.sectionSlots.get(sectionKey)
    if (!slot) return false
    if (this.pendingMove?.key === sectionKey) return false
    if (this.pendingReplace.has(sectionKey)) return false
    if (!this.rangeFullyUploaded(slot.start, slot.start + slot.count - 1)) return false
    if (slot.count < 2) return false

    const dstFloatBase = slot.start * VERTS_PER_QUAD * FLOATS_PER_VERT
    const sx = this.aOrigin[dstFloatBase]! + this.renderOrigin.x
    const sy = this.aOrigin[dstFloatBase + 1]! + this.renderOrigin.y
    const sz = this.aOrigin[dstFloatBase + 2]! + this.renderOrigin.z

    const order = new Array<number>(slot.count)
    const distSq = new Float64Array(slot.count)
    for (let p = 0; p < slot.count; p++) {
      order[p] = p
      const physQuad = slot.start + p
      const centBase = physQuad * 3
      const wx = sx + this.quadCentroids[centBase]!
      const wy = sy + this.quadCentroids[centBase + 1]!
      const wz = sz + this.quadCentroids[centBase + 2]!
      const dx = wx - camX
      const dy = wy - camY
      const dz = wz - camZ
      distSq[p] = dx * dx + dy * dy + dz * dz
    }
    order.sort((a, b) => {
      const d = distSq[b]! - distSq[a]!
      if (d !== 0) return d
      return a - b
    })

    for (let k = 0; k < slot.count; k++) {
      const src = order[k]!
      const srcVertBase = (slot.start + src) * VERTS_PER_QUAD
      const dstIdxBase = (slot.start + k) * INDICES_PER_QUAD
      const tmplBase = (slot.start + src) * INDICES_PER_QUAD
      for (let i = 0; i < INDICES_PER_QUAD; i++) {
        this.indices[dstIdxBase + i] = srcVertBase + this.quadIndexTemplate[tmplBase + i]!
      }
    }

    this.markIndexDirty(slot.start, slot.start + slot.count - 1)
    return true
  }

  uploadDirtyRange(): void {
    const r = this.pendingRanges[0]
    if (!r) return

    const quadOffset = r.start
    const quadCount = Math.min(r.end - r.start + 1, MAX_UPLOAD_QUADS_PER_FRAME)
    const vertOffset = quadOffset * VERTS_PER_QUAD
    const vertCount = quadCount * VERTS_PER_QUAD
    const indexOffset = quadOffset * INDICES_PER_QUAD
    const indexCount = quadCount * INDICES_PER_QUAD

    const geometry = this.mesh.geometry
    const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute
    posAttr.clearUpdateRanges()
    posAttr.addUpdateRange(vertOffset * FLOATS_PER_VERT, vertCount * FLOATS_PER_VERT)
    posAttr.needsUpdate = true

    const colorAttr = geometry.getAttribute('color') as THREE.BufferAttribute
    colorAttr.clearUpdateRanges()
    colorAttr.addUpdateRange(vertOffset * FLOATS_PER_VERT, vertCount * FLOATS_PER_VERT)
    colorAttr.needsUpdate = true

    const skyAttr = geometry.getAttribute('a_skyLight') as THREE.BufferAttribute
    skyAttr.clearUpdateRanges()
    skyAttr.addUpdateRange(vertOffset * FLOATS_PER_LIGHT_VERT, vertCount * FLOATS_PER_LIGHT_VERT)
    skyAttr.needsUpdate = true

    const blockAttr = geometry.getAttribute('a_blockLight') as THREE.BufferAttribute
    blockAttr.clearUpdateRanges()
    blockAttr.addUpdateRange(vertOffset * FLOATS_PER_LIGHT_VERT, vertCount * FLOATS_PER_LIGHT_VERT)
    blockAttr.needsUpdate = true

    const uvAttr = geometry.getAttribute('uv') as THREE.BufferAttribute
    uvAttr.clearUpdateRanges()
    uvAttr.addUpdateRange(vertOffset * FLOATS_PER_UV_VERT, vertCount * FLOATS_PER_UV_VERT)
    uvAttr.needsUpdate = true

    const originAttr = geometry.getAttribute('a_origin') as THREE.BufferAttribute
    originAttr.clearUpdateRanges()
    originAttr.addUpdateRange(vertOffset * FLOATS_PER_VERT, vertCount * FLOATS_PER_VERT)
    originAttr.needsUpdate = true

    const indexAttr = geometry.index as THREE.BufferAttribute
    indexAttr.clearUpdateRanges()
    indexAttr.addUpdateRange(indexOffset, indexCount)
    indexAttr.needsUpdate = true

    if (quadOffset + quadCount > r.end) {
      this.pendingRanges.shift()
    } else {
      r.start = quadOffset + quadCount
    }
    this.uploadEpoch++
  }

  uploadDirtyIndexRange(): void {
    const r = this.indexPendingRanges[0]
    if (!r) return

    const quadOffset = r.start
    const quadCount = Math.min(r.end - r.start + 1, MAX_UPLOAD_QUADS_PER_FRAME)
    const indexOffset = quadOffset * INDICES_PER_QUAD
    const indexCount = quadCount * INDICES_PER_QUAD

    const indexAttr = this.mesh.geometry.index as THREE.BufferAttribute
    indexAttr.clearUpdateRanges()
    indexAttr.addUpdateRange(indexOffset, indexCount)
    indexAttr.needsUpdate = true

    if (quadOffset + quadCount > r.end) {
      this.indexPendingRanges.shift()
    } else {
      r.start = quadOffset + quadCount
    }
  }

  setRenderOrigin(renderOrigin: RenderOrigin): void {
    this.renderOrigin = { ...renderOrigin }
  }

  rebase(delta: RenderOrigin): void {
    if (this.highWatermark === 0) return
    for (const slot of this.sectionSlots.values()) {
      const dstVertBase = slot.start * VERTS_PER_QUAD
      const vertCount = slot.count * VERTS_PER_QUAD
      const dstFloatBase = dstVertBase * FLOATS_PER_VERT
      for (let v = 0; v < vertCount; v++) {
        const o = dstFloatBase + v * FLOATS_PER_VERT
        this.aOrigin[o]! -= delta.x
        this.aOrigin[o + 1]! -= delta.y
        this.aOrigin[o + 2]! -= delta.z
      }
    }
    this.markDirty(0, this.highWatermark - 1)
    this.renderOrigin.x += delta.x
    this.renderOrigin.y += delta.y
    this.renderOrigin.z += delta.z
  }

  setCameraOrigin(x: number, y: number, z: number): void {
    const { originDelta, cameraOriginFrac } = computeCameraRelativeUniforms(this.renderOrigin, x, y, z)
    const u = this.material.uniforms.u_originDelta
    if (u?.value?.set) u.value.set(originDelta.x, originDelta.y, originDelta.z)
    const uf = this.material.uniforms.u_cameraOriginFrac
    if (uf?.value?.set) uf.value.set(cameraOriginFrac.x, cameraOriginFrac.y, cameraOriginFrac.z)
  }

  getHighWatermark(): number {
    return this.highWatermark
  }

  getCapacityQuads(): number {
    return this.capacityQuads
  }

  getSectionCount(): number {
    return this.sectionSlots.size
  }

  getMemoryBytes(): number {
    return this.capacityQuads * LEGACY_BYTES_PER_QUAD
  }

  getUsedMemoryBytes(): number {
    return this.highWatermark * LEGACY_BYTES_PER_QUAD
  }

  reset(): void {
    this.sectionSlots.clear()
    this.freeList.length = 0
    this.highWatermark = 0
    this.pendingRanges.length = 0
    this.indexPendingRanges.length = 0
    this.pendingMove = null
    this.pendingReplace.clear()
    this.uploadEpoch = 0
    this.visibleIndexSpans = []
    this.syncDefaultDrawGroups()
  }

  dispose(): void {
    this.mesh.parent?.remove(this.mesh)
    this.mesh.geometry.dispose()
    this.reset()
  }

  private markDirty(start: number, end: number): void {
    this.pendingRanges.push({ start, end })
    this.pendingRanges.sort((a, b) => a.start - b.start)
    this.mergePendingRanges()
  }

  private markIndexDirty(start: number, end: number): void {
    this.indexPendingRanges.push({ start, end })
    this.indexPendingRanges.sort((a, b) => a.start - b.start)
    this.mergeIndexPendingRanges()
  }

  private mergeIndexPendingRanges(): void {
    if (this.indexPendingRanges.length < 2) return
    const merged: Array<{ start: number; end: number }> = []
    let cur = this.indexPendingRanges[0]!
    for (let i = 1; i < this.indexPendingRanges.length; i++) {
      const next = this.indexPendingRanges[i]!
      if (next.start <= cur.end + 1) {
        cur = { start: cur.start, end: Math.max(cur.end, next.end) }
      } else {
        merged.push(cur)
        cur = next
      }
    }
    merged.push(cur)
    this.indexPendingRanges = merged
  }

  private mergePendingRanges(): void {
    if (this.pendingRanges.length < 2) return
    const merged: Array<{ start: number; end: number }> = []
    let cur = this.pendingRanges[0]!
    for (let i = 1; i < this.pendingRanges.length; i++) {
      const next = this.pendingRanges[i]!
      if (next.start <= cur.end + 1) {
        cur = { start: cur.start, end: Math.max(cur.end, next.end) }
      } else {
        merged.push(cur)
        cur = next
      }
    }
    merged.push(cur)
    this.pendingRanges = merged
  }

  private takeFreeSlot(count: number): { start: number; count: number } | undefined {
    for (let i = 0; i < this.freeList.length; i++) {
      const slot = this.freeList[i]!
      if (slot.count >= count) {
        this.freeList.splice(i, 1)
        if (slot.count === count) return slot
        const used = { start: slot.start, count }
        this.insertFreeSlot({ start: slot.start + count, count: slot.count - count })
        return used
      }
    }
    return undefined
  }

  private insertFreeSlot(slot: { start: number; count: number }): void {
    this.freeList.push(slot)
    this.freeList.sort((a, b) => a.start - b.start)
    this.mergeFreeList()
  }

  private mergeFreeList(): void {
    if (this.freeList.length < 2) return
    const merged: Array<{ start: number; count: number }> = []
    let cur = this.freeList[0]!
    for (let i = 1; i < this.freeList.length; i++) {
      const next = this.freeList[i]!
      if (cur.start + cur.count === next.start) {
        cur = { start: cur.start, count: cur.count + next.count }
      } else {
        merged.push(cur)
        cur = next
      }
    }
    merged.push(cur)
    this.freeList = merged
  }

  private shrinkHighWatermark(): void {
    while (this.highWatermark > 0) {
      const tail = this.highWatermark - 1
      const free = this.freeList.find(s => s.start <= tail && s.start + s.count > tail)
      if (!free || free.start + free.count !== this.highWatermark) break
      this.highWatermark = free.start
      const idx = this.freeList.indexOf(free)
      this.freeList.splice(idx, 1)
    }
  }

  private interiorFreeQuads(): number {
    let total = 0
    for (const slot of this.freeList) {
      if (slot.start < this.highWatermark) total += slot.count
    }
    return total
  }

  private findMovableSection(maxCount: number): { key: string; start: number; count: number } | undefined {
    const sections: Array<{ key: string; start: number; count: number }> = []
    for (const [key, slot] of this.sectionSlots) {
      sections.push({ key, start: slot.start, count: slot.count })
    }
    if (sections.length === 0) return undefined

    sections.sort((a, b) => {
      if (b.start !== a.start) return b.start - a.start
      return b.start + b.count - (a.start + a.count)
    })

    const tailmost = sections[0]!
    if (tailmost.count <= maxCount && this.findLowestInteriorHole(tailmost.start, tailmost.count)) {
      return tailmost
    }

    const candidates = sections.filter(s => s.count <= maxCount).sort((a, b) => b.count - a.count)

    for (const s of candidates) {
      if (this.findLowestInteriorHole(s.start, s.count)) return s
    }
    return undefined
  }

  private findLowestInteriorHole(sectionStart: number, count: number): { start: number; count: number; index: number } | undefined {
    for (let i = 0; i < this.freeList.length; i++) {
      const slot = this.freeList[i]!
      if (slot.start < sectionStart && slot.count >= count) {
        return { start: slot.start, count: slot.count, index: i }
      }
    }
    return undefined
  }

  private reserveFreeSlotAt(index: number, count: number): { start: number; count: number } {
    const slot = this.freeList[index]!
    this.freeList.splice(index, 1)
    if (slot.count === count) return { start: slot.start, count }
    const used = { start: slot.start, count }
    this.insertFreeSlot({ start: slot.start + count, count: slot.count - count })
    return used
  }

  private copySectionRange(oldStart: number, newStart: number, quadCount: number): void {
    const oldVertBase = oldStart * VERTS_PER_QUAD
    const newVertBase = newStart * VERTS_PER_QUAD
    const vertCount = quadCount * VERTS_PER_QUAD
    const vertDelta = newVertBase - oldVertBase

    const oldFloatBase = oldVertBase * FLOATS_PER_VERT
    const newFloatBase = newVertBase * FLOATS_PER_VERT
    const floatLen = vertCount * FLOATS_PER_VERT
    this.positions.copyWithin(newFloatBase, oldFloatBase, oldFloatBase + floatLen)
    this.colors.copyWithin(newFloatBase, oldFloatBase, oldFloatBase + floatLen)
    this.aOrigin.copyWithin(newFloatBase, oldFloatBase, oldFloatBase + floatLen)

    const oldLightBase = oldVertBase * FLOATS_PER_LIGHT_VERT
    const newLightBase = newVertBase * FLOATS_PER_LIGHT_VERT
    const lightLen = vertCount * FLOATS_PER_LIGHT_VERT
    this.skyLights.copyWithin(newLightBase, oldLightBase, oldLightBase + lightLen)
    this.blockLights.copyWithin(newLightBase, oldLightBase, oldLightBase + lightLen)

    const oldUvBase = oldVertBase * FLOATS_PER_UV_VERT
    const newUvBase = newVertBase * FLOATS_PER_UV_VERT
    const uvLen = vertCount * FLOATS_PER_UV_VERT
    this.uvs.copyWithin(newUvBase, oldUvBase, oldUvBase + uvLen)

    const oldIndexBase = oldStart * INDICES_PER_QUAD
    const newIndexBase = newStart * INDICES_PER_QUAD
    const indexLen = quadCount * INDICES_PER_QUAD
    for (let i = 0; i < indexLen; i++) {
      this.indices[newIndexBase + i] = this.indices[oldIndexBase + i]! + vertDelta
    }

    const oldCentroidBase = oldStart * 3
    const newCentroidBase = newStart * 3
    this.quadCentroids.copyWithin(newCentroidBase, oldCentroidBase, oldCentroidBase + quadCount * 3)

    const oldTemplateBase = oldStart * INDICES_PER_QUAD
    const newTemplateBase = newStart * INDICES_PER_QUAD
    this.quadIndexTemplate.copyWithin(newTemplateBase, oldTemplateBase, oldTemplateBase + quadCount * INDICES_PER_QUAD)
  }

  private rangeFullyUploaded(start: number, end: number): boolean {
    for (const r of this.pendingRanges) {
      if (r.start <= end && r.end >= start) return false
    }
    return true
  }

  private zeroAndFreeSlot(start: number, count: number): void {
    const oldIndexBase = start * INDICES_PER_QUAD
    const oldIndexLen = count * INDICES_PER_QUAD
    for (let i = 0; i < oldIndexLen; i++) {
      this.indices[oldIndexBase + i] = 0
    }
    this.markDirty(start, start + count - 1)
    this.insertFreeSlot({ start, count })
  }

  private finalizePendingReplace(key: string): void {
    const pr = this.pendingReplace.get(key)
    if (!pr) return

    this.zeroAndFreeSlot(pr.oldStart, pr.oldCount)
    this.pendingReplace.delete(key)
    this.shrinkHighWatermark()
    this.syncDefaultDrawGroups()
    this.layoutVersion++
    this.uploadEpoch++
  }

  private finalizePendingMove(): void {
    const move = this.pendingMove
    if (!move) return

    const { oldStart, count } = move
    this.zeroAndFreeSlot(oldStart, count)
    this.shrinkHighWatermark()
    this.syncDefaultDrawGroups()
    this.pendingMove = null
    this.layoutVersion++
    this.uploadEpoch++
  }

  private growCapacity(minQuads: number): void {
    if (this.pendingMove) this.finalizePendingMove()
    for (const key of [...this.pendingReplace.keys()]) {
      this.finalizePendingReplace(key)
    }

    let newCap = this.capacityQuads
    while (newCap < minQuads) newCap += this.growthIncrementQuads

    const oldMaxVerts = this.capacityQuads * VERTS_PER_QUAD
    const newMaxVerts = newCap * VERTS_PER_QUAD

    const nPos = new Float32Array(newMaxVerts * FLOATS_PER_VERT)
    const nCol = new Float32Array(newMaxVerts * FLOATS_PER_VERT)
    const nSky = new Float32Array(newMaxVerts * FLOATS_PER_LIGHT_VERT)
    const nBlock = new Float32Array(newMaxVerts * FLOATS_PER_LIGHT_VERT)
    const nUv = new Float32Array(newMaxVerts * FLOATS_PER_UV_VERT)
    const nOrigin = new Float32Array(newMaxVerts * FLOATS_PER_VERT)
    const nIdx = new Uint32Array(newCap * INDICES_PER_QUAD)
    const nCentroids = new Float32Array(newCap * 3)
    const nTemplate = new Uint8Array(newCap * INDICES_PER_QUAD)

    nPos.set(this.positions)
    nCol.set(this.colors)
    nSky.set(this.skyLights)
    nBlock.set(this.blockLights)
    nUv.set(this.uvs)
    nOrigin.set(this.aOrigin)
    nIdx.set(this.indices)
    nCentroids.set(this.quadCentroids)
    nTemplate.set(this.quadIndexTemplate)

    this.positions = nPos
    this.colors = nCol
    this.skyLights = nSky
    this.blockLights = nBlock
    this.uvs = nUv
    this.aOrigin = nOrigin
    this.indices = nIdx
    this.quadCentroids = nCentroids
    this.quadIndexTemplate = nTemplate
    this.capacityQuads = newCap

    const geometry = this.mesh.geometry
    const replaceAttr = (arr: Float32Array, itemSize: number, name: string) => {
      const prev = geometry.getAttribute(name)
      if (prev) geometry.deleteAttribute(name)
      const attr = new THREE.BufferAttribute(arr, itemSize)
      attr.setUsage(THREE.DynamicDrawUsage)
      geometry.setAttribute(name, attr)
    }
    replaceAttr(this.positions, FLOATS_PER_VERT, 'position')
    replaceAttr(this.colors, FLOATS_PER_VERT, 'color')
    replaceAttr(this.skyLights, FLOATS_PER_LIGHT_VERT, 'a_skyLight')
    replaceAttr(this.blockLights, FLOATS_PER_LIGHT_VERT, 'a_blockLight')
    replaceAttr(this.uvs, FLOATS_PER_UV_VERT, 'uv')
    replaceAttr(this.aOrigin, FLOATS_PER_VERT, 'a_origin')

    const prevIndex = geometry.index
    if (prevIndex) geometry.setIndex(null)
    const indexAttr = new THREE.BufferAttribute(this.indices, 1)
    indexAttr.setUsage(THREE.DynamicDrawUsage)
    geometry.setIndex(indexAttr)

    this.pendingRanges.length = 0
    this.indexPendingRanges.length = 0
  }
}
