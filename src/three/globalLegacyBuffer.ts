import * as THREE from 'three'
import { computeCameraRelativeUniforms, type RenderOrigin } from './shaders/legacyBlockShader'

const VERTS_PER_QUAD = 4
const INDICES_PER_QUAD = 6
const FLOATS_PER_VERT = 3
const FLOATS_PER_UV_VERT = 2
const FLOATS_PER_LIGHT_VERT = 1

const DEFAULT_INITIAL_CAPACITY_QUADS = 128_000
const DEFAULT_GROWTH_INCREMENT_QUADS = 128_000
const MAX_UPLOAD_QUADS_PER_FRAME = 5_000

export const FULL_DRAW_VISIBLE_FRACTION = 0.75
export const SPAN_GAP_TOLERANCE_QUADS = 256
export const MAX_OPAQUE_SPANS = 64

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
  private readonly sectionSlots = new Map<string, { start: number; count: number }>()
  private freeList: Array<{ start: number; count: number }> = []
  private highWatermark = 0
  private pendingRanges: Array<{ start: number; end: number }> = []
  private readonly _spanScratch: Array<{ start: number; count: number }> = []
  private renderOrigin: RenderOrigin = { x: 0, y: 0, z: 0 }

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

    if (this.sectionSlots.has(sectionKey)) {
      this.removeSection(sectionKey)
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
    const rx = this.renderOrigin.x
    const ry = this.renderOrigin.y
    const rz = this.renderOrigin.z
    for (let v = 0; v < vertCount; v++) {
      const o = originOff + v * FLOATS_PER_VERT
      this.aOrigin[o] = sx - rx
      this.aOrigin[o + 1] = sy - ry
      this.aOrigin[o + 2] = sz - rz
    }

    const dstIndexBase = slot.start * INDICES_PER_QUAD
    const vertexBase = dstVertBase
    for (let i = 0; i < geo.indices.length; i++) {
      this.indices[dstIndexBase + i] = geo.indices[i]! + vertexBase
    }

    this.sectionSlots.set(sectionKey, slot)
    this.markDirty(slot.start, slot.start + quadCount - 1)
    this.syncDefaultDrawGroups()
    return true
  }

  updateDrawSpans(visible: VisibleSectionSpan[], mode: 'opaque' | 'sortedBlend'): void {
    const geometry = this.mesh.geometry
    geometry.clearGroups()

    if (this.highWatermark === 0) {
      geometry.setDrawRange(0, 0)
      return
    }

    const spans = this._spanScratch
    spans.length = 0
    let visibleQuadCount = 0

    for (const entry of visible) {
      const slot = this.sectionSlots.get(entry.key)
      if (!slot) continue
      spans.push({ start: slot.start, count: slot.count })
      visibleQuadCount += slot.count
    }

    if (spans.length === 0) {
      geometry.setDrawRange(0, 0)
      return
    }

    if (mode === 'opaque') {
      if (visibleQuadCount >= this.highWatermark * FULL_DRAW_VISIBLE_FRACTION) {
        geometry.addGroup(0, this.highWatermark * INDICES_PER_QUAD, 0)
        geometry.setDrawRange(0, this.highWatermark * INDICES_PER_QUAD)
        return
      }

      spans.sort((a, b) => a.start - b.start)
      this.mergeOpaqueSpans(spans)
      this.capOpaqueSpans(spans)

      for (const span of spans) {
        geometry.addGroup(span.start * INDICES_PER_QUAD, span.count * INDICES_PER_QUAD, 0)
      }
    } else {
      visible.sort((a, b) => b.distSq - a.distSq)
      for (const entry of visible) {
        const slot = this.sectionSlots.get(entry.key)
        if (!slot) continue
        geometry.addGroup(slot.start * INDICES_PER_QUAD, slot.count * INDICES_PER_QUAD, 0)
      }
    }

    geometry.setDrawRange(0, this.highWatermark * INDICES_PER_QUAD)
  }

  private mergeOpaqueSpans(spans: Array<{ start: number; count: number }>): void {
    if (spans.length < 2) return
    let i = 0
    while (i < spans.length - 1) {
      const cur = spans[i]!
      const next = spans[i + 1]!
      const gap = next.start - (cur.start + cur.count)
      if (gap <= SPAN_GAP_TOLERANCE_QUADS) {
        cur.count = next.start + next.count - cur.start
        spans.splice(i + 1, 1)
      } else {
        i++
      }
    }
  }

  private capOpaqueSpans(spans: Array<{ start: number; count: number }>): void {
    while (spans.length > MAX_OPAQUE_SPANS) {
      let bestIdx = 0
      let bestGap = Infinity
      for (let i = 0; i < spans.length - 1; i++) {
        const gap = spans[i + 1]!.start - (spans[i]!.start + spans[i]!.count)
        if (gap < bestGap) {
          bestGap = gap
          bestIdx = i
        }
      }
      const cur = spans[bestIdx]!
      const next = spans[bestIdx + 1]!
      cur.count = next.start + next.count - cur.start
      spans.splice(bestIdx + 1, 1)
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
  }

  hasPendingUploads(): boolean {
    return this.pendingRanges.length > 0
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

    if (quadOffset + quadCount > r.end) this.pendingRanges.shift()
    else r.start = quadOffset + quadCount
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

  raycastSections(raycaster: THREE.Raycaster, sectionKeys: Iterable<string>, out: THREE.Intersection[]): THREE.Intersection[] {
    const ray = raycaster.ray
    const closest = raycaster.near
    const far = raycaster.far
    _raycastOrigin.copy(ray.origin).sub(_raycastRenderOrigin.set(this.renderOrigin.x, this.renderOrigin.y, this.renderOrigin.z))
    _raycastRay.origin.copy(_raycastOrigin)
    _raycastRay.direction.copy(ray.direction)

    for (const key of sectionKeys) {
      const slot = this.sectionSlots.get(key)
      if (!slot) continue

      const dstVertBase = slot.start * VERTS_PER_QUAD
      const dstFloatBase = dstVertBase * FLOATS_PER_VERT
      const dstIndexBase = slot.start * INDICES_PER_QUAD
      const indexLen = slot.count * INDICES_PER_QUAD

      for (let i = 0; i < indexLen; i += 3) {
        const i0 = this.indices[dstIndexBase + i]!
        const i1 = this.indices[dstIndexBase + i + 1]!
        const i2 = this.indices[dstIndexBase + i + 2]!
        if (i0 === i1 && i1 === i2) continue

        const hit = intersectTriangle(_raycastRay, this.positions, this.aOrigin, dstFloatBase, i0, i1, i2, closest, far)
        if (hit !== null) {
          out.push({
            distance: hit,
            point: ray.at(hit, new THREE.Vector3()),
            object: this.mesh,
            face: null,
            faceIndex: Math.floor(i / 3)
          })
        }
      }
    }

    out.sort((a, b) => a.distance - b.distance)
    return out
  }

  getMemoryBytes(): number {
    const verts = this.capacityQuads * VERTS_PER_QUAD
    return verts * (FLOATS_PER_VERT * 3 + FLOATS_PER_LIGHT_VERT * 2 + FLOATS_PER_UV_VERT) * 4 + this.capacityQuads * INDICES_PER_QUAD * 4
  }

  reset(): void {
    this.sectionSlots.clear()
    this.freeList.length = 0
    this.highWatermark = 0
    this.pendingRanges.length = 0
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

  private growCapacity(minQuads: number): void {
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

    nPos.set(this.positions)
    nCol.set(this.colors)
    nSky.set(this.skyLights)
    nBlock.set(this.blockLights)
    nUv.set(this.uvs)
    nOrigin.set(this.aOrigin)
    nIdx.set(this.indices)

    this.positions = nPos
    this.colors = nCol
    this.skyLights = nSky
    this.blockLights = nBlock
    this.uvs = nUv
    this.aOrigin = nOrigin
    this.indices = nIdx
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
  }
}

const _vA = new THREE.Vector3()
const _vB = new THREE.Vector3()
const _vC = new THREE.Vector3()
const _edge1 = new THREE.Vector3()
const _edge2 = new THREE.Vector3()
const _normal = new THREE.Vector3()
const _raycastOrigin = new THREE.Vector3()
const _raycastRenderOrigin = new THREE.Vector3()
const _raycastRay = new THREE.Ray()

function readWorldVertex(positions: Float32Array, aOrigin: Float32Array, floatBase: number, vertIndex: number, target: THREE.Vector3): void {
  const f = floatBase + vertIndex * FLOATS_PER_VERT
  target.set(aOrigin[f]! + positions[f]!, aOrigin[f + 1]! + positions[f + 1]!, aOrigin[f + 2]! + positions[f + 2]!)
}

function intersectTriangle(
  ray: THREE.Ray,
  positions: Float32Array,
  aOrigin: Float32Array,
  floatBase: number,
  i0: number,
  i1: number,
  i2: number,
  near: number,
  far: number
): number | null {
  readWorldVertex(positions, aOrigin, floatBase, i0, _vA)
  readWorldVertex(positions, aOrigin, floatBase, i1, _vB)
  readWorldVertex(positions, aOrigin, floatBase, i2, _vC)

  _edge1.subVectors(_vB, _vA)
  _edge2.subVectors(_vC, _vA)
  _normal.crossVectors(_edge1, _edge2)

  const denom = _normal.dot(ray.direction)
  if (Math.abs(denom) < 1e-8) return null

  const t = _vA.clone().sub(ray.origin).dot(_normal) / denom
  if (t < near || t > far) return null

  const p = ray.at(t, new THREE.Vector3())
  if (!pointInTriangle(p, _vA, _vB, _vC)) return null
  return t
}

function pointInTriangle(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): boolean {
  _edge1.subVectors(b, a)
  _edge2.subVectors(c, a)
  const n = _normal.crossVectors(_edge1, _edge2).normalize()

  const ab = _edge1
  const ac = _edge2
  const ap = p.clone().sub(a)

  const d00 = ab.dot(ab)
  const d01 = ab.dot(ac)
  const d11 = ac.dot(ac)
  const d20 = ap.dot(ab)
  const d21 = ap.dot(ac)
  const denom = d00 * d11 - d01 * d01
  if (Math.abs(denom) < 1e-12) return false
  const v = (d11 * d20 - d01 * d21) / denom
  const w = (d00 * d21 - d01 * d20) / denom
  const u = 1 - v - w
  return u >= -1e-4 && v >= -1e-4 && w >= -1e-4
}
