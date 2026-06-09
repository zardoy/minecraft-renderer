import * as THREE from 'three'
import { VERTICES_PER_FACE } from './shaders/cubeBlockShader'
import { packWord2Empty } from '../wasm-mesher/bridge/shaderCubeBridge'

// Linear growth (NOT doubling) to keep iOS allocation spikes bounded to one increment.
// Reference: prismarine-web-client PR #90 (webgl) and #120 (webgpu) both grow by +1M faces.
const INITIAL_CAPACITY_FACES = 512_000      // ~8 MB up front (4 words × 4 B), well under 1M
const GROWTH_INCREMENT_FACES = 1_000_000    // +16 MB per growth step instead of doubling
const MAX_UPLOAD_FACES_PER_FRAME = 15_000   // face-indexed budget (chunksStorage uses 10k blocks)
const FRAGMENTATION_THRESHOLD = 0.25
const EMPTY_W2 = packWord2Empty()

type PendingMove = { key: string, oldStart: number, newStart: number, count: number }

export type GlobalBlockBufferShaderData = {
  words: Uint32Array
  count: number
}

/**
 * Single GPU instanced mesh for all shader-cube faces in the world.
 * Camera-relative positioning via u_cameraOrigin; no sceneOrigin tracking.
 */
export class GlobalBlockBuffer {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>

  private capacityFaces: number
  private w0: Uint32Array
  private w1: Uint32Array
  private w2: Uint32Array
  private w3: Uint32Array
  private readonly sectionSlots = new Map<string, { start: number, count: number }>()
  private freeList: Array<{ start: number, count: number }> = []
  private highWatermark = 0
  private pendingRanges: Array<{ start: number, end: number }> = []
  private pendingMove: PendingMove | null = null

  constructor (
    material: THREE.ShaderMaterial,
    scene: THREE.Object3D,
  ) {
    this.capacityFaces = INITIAL_CAPACITY_FACES
    this.w0 = new Uint32Array(this.capacityFaces)
    this.w1 = new Uint32Array(this.capacityFaces)
    this.w2 = new Uint32Array(this.capacityFaces)
    this.w3 = new Uint32Array(this.capacityFaces)
    this.w2.fill(EMPTY_W2)

    const geometry = new THREE.InstancedBufferGeometry()
    const positions = new Float32Array(VERTICES_PER_FACE * 3)
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))

    const mkAttr = (arr: Uint32Array) => {
      const attr = new THREE.InstancedBufferAttribute(arr, 1)
      attr.setUsage(THREE.DynamicDrawUsage)
      return attr
    }
    geometry.setAttribute('a_w0', mkAttr(this.w0))
    geometry.setAttribute('a_w1', mkAttr(this.w1))
    geometry.setAttribute('a_w2', mkAttr(this.w2))
    geometry.setAttribute('a_w3', mkAttr(this.w3))

    geometry.instanceCount = 0

    this.mesh = new THREE.Mesh(geometry, material)
    this.mesh.name = 'globalShaderCubes'
    this.mesh.frustumCulled = false
    this.mesh.matrixAutoUpdate = false
    this.mesh.matrix.identity()
    this.mesh.position.set(0, 0, 0)
    scene.add(this.mesh)
  }

  addSection (sectionKey: string, words: Uint32Array, faceCount: number): void {
    if (faceCount <= 0) {
      this.removeSection(sectionKey)
      return
    }

    if (this.sectionSlots.has(sectionKey)) {
      this.removeSection(sectionKey)
    }

    if (faceCount > this.capacityFaces) {
      this.growCapacity(faceCount)
    }

    let slot = this.takeFreeSlot(faceCount)
    if (!slot) {
      if (this.highWatermark + faceCount > this.capacityFaces) {
        this.growCapacity(this.highWatermark + faceCount)
      }
      slot = { start: this.highWatermark, count: faceCount }
      this.highWatermark += faceCount
    }

    const stride = 4
    for (let i = 0; i < faceCount; i++) {
      const dst = slot.start + i
      const src = i * stride
      this.w0[dst] = words[src]!
      this.w1[dst] = words[src + 1]!
      this.w2[dst] = words[src + 2]!
      this.w3[dst] = words[src + 3]!
    }

    this.sectionSlots.set(sectionKey, slot)
    this.markDirty(slot.start, slot.start + faceCount - 1)
    this.mesh.geometry.instanceCount = this.highWatermark
  }

  hasSection (sectionKey: string): boolean {
    return this.sectionSlots.has(sectionKey)
  }

  getSectionSlot (sectionKey: string): { start: number, count: number } | undefined {
    return this.sectionSlots.get(sectionKey)
  }

  /** Fetch fresh each raycast — growCapacity reallocates the backing array. */
  getW0 (): Uint32Array {
    return this.w0
  }

  /** Copy live GPU words and remove the section (sci-fi reveal hide / restore). */
  takeSectionData (sectionKey: string): GlobalBlockBufferShaderData | undefined {
    const slot = this.sectionSlots.get(sectionKey)
    if (!slot) return undefined

    const stride = 4
    const words = new Uint32Array(slot.count * stride)
    for (let i = 0; i < slot.count; i++) {
      const dst = slot.start + i
      const src = i * stride
      words[src] = this.w0[dst]!
      words[src + 1] = this.w1[dst]!
      words[src + 2] = this.w2[dst]!
      words[src + 3] = this.w3[dst]!
    }
    this.removeSection(sectionKey)
    return { words, count: slot.count }
  }

  removeSection (sectionKey: string): void {
    const slot = this.sectionSlots.get(sectionKey)
    if (!slot) return

    if (this.pendingMove?.key === sectionKey) {
      const { oldStart, count } = this.pendingMove
      for (let i = oldStart; i < oldStart + count; i++) {
        this.w0[i] = 0
        this.w1[i] = 0
        this.w2[i] = EMPTY_W2
        this.w3[i] = 0
      }
      this.markDirty(oldStart, oldStart + count - 1)
      this.insertFreeSlot({ start: oldStart, count })
      this.pendingMove = null
    }

    for (let i = slot.start; i < slot.start + slot.count; i++) {
      this.w0[i] = 0
      this.w1[i] = 0
      this.w2[i] = EMPTY_W2
      this.w3[i] = 0
    }

    this.markDirty(slot.start, slot.start + slot.count - 1)
    this.sectionSlots.delete(sectionKey)
    this.insertFreeSlot(slot)
    this.shrinkHighWatermark()
    this.mesh.geometry.instanceCount = this.highWatermark
  }

  /** One interior-hole move per frame when fragmentation exceeds threshold; deferred shrink. */
  compactStep (): void {
    if (this.pendingMove) {
      const { newStart, count } = this.pendingMove
      if (this.rangeFullyUploaded(newStart, newStart + count - 1)) {
        this.finalizePendingMove()
      }
      return
    }

    if (this.highWatermark === 0) return
    const interiorFree = this.interiorFreeFaces()
    if (interiorFree / this.highWatermark <= FRAGMENTATION_THRESHOLD) return

    const section = this.findMovableSection(MAX_UPLOAD_FACES_PER_FRAME)
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
  }

  uploadDirtyRange (): void {
    const r = this.pendingRanges[0]
    if (!r) return

    const offset = r.start
    const count = Math.min(r.end - r.start + 1, MAX_UPLOAD_FACES_PER_FRAME)
    const geometry = this.mesh.geometry

    for (const name of ['a_w0', 'a_w1', 'a_w2', 'a_w3'] as const) {
      const attr = geometry.getAttribute(name) as THREE.InstancedBufferAttribute
      attr.updateRange.offset = offset
      attr.updateRange.count = count
      attr.needsUpdate = true
    }

    if (offset + count > r.end) this.pendingRanges.shift()
    else r.start = offset + count
  }

  setCameraOrigin (x: number, y: number, z: number): void {
    // Integer + fractional parts — see cubeBlockShader position math.
    const ix = Math.floor(x)
    const iy = Math.floor(y)
    const iz = Math.floor(z)
    const u = this.mesh.material.uniforms.u_cameraOrigin
    if (u?.value?.set) {
      u.value.set(ix, iy, iz)
    }
    const uf = this.mesh.material.uniforms.u_cameraOriginFrac
    if (uf?.value?.set) {
      uf.value.set(x - ix, y - iy, z - iz)
    }
  }

  reset (): void {
    this.sectionSlots.clear()
    this.freeList.length = 0
    this.highWatermark = 0
    this.pendingRanges.length = 0
    this.pendingMove = null
    this.w0.fill(0)
    this.w1.fill(0)
    this.w2.fill(EMPTY_W2)
    this.w3.fill(0)
    this.mesh.geometry.instanceCount = 0
  }

  dispose (): void {
    this.mesh.parent?.remove(this.mesh)
    this.mesh.geometry.dispose()
    this.reset()
  }

  private markDirty (start: number, end: number): void {
    this.pendingRanges.push({ start, end })
    this.pendingRanges.sort((a, b) => a.start - b.start)
    this.mergePendingRanges()
  }

  private mergePendingRanges (): void {
    if (this.pendingRanges.length < 2) return
    const merged: Array<{ start: number, end: number }> = []
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

  private takeFreeSlot (count: number): { start: number, count: number } | undefined {
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

  private insertFreeSlot (slot: { start: number, count: number }): void {
    this.freeList.push(slot)
    this.freeList.sort((a, b) => a.start - b.start)
    this.mergeFreeList()
  }

  private mergeFreeList (): void {
    if (this.freeList.length < 2) return
    const merged: Array<{ start: number, count: number }> = []
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

  private interiorFreeFaces (): number {
    let total = 0
    for (const slot of this.freeList) {
      if (slot.start < this.highWatermark) total += slot.count
    }
    return total
  }

  private findMovableSection (maxCount: number): { key: string, start: number, count: number } | undefined {
    const sections: Array<{ key: string, start: number, count: number }> = []
    for (const [key, slot] of this.sectionSlots) {
      sections.push({ key, start: slot.start, count: slot.count })
    }
    if (sections.length === 0) return undefined

    sections.sort((a, b) => {
      if (b.start !== a.start) return b.start - a.start
      return (b.start + b.count) - (a.start + a.count)
    })

    const tailmost = sections[0]!
    if (tailmost.count <= maxCount && this.findLowestInteriorHole(tailmost.start, tailmost.count)) {
      return tailmost
    }

    const candidates = sections
      .filter(s => s.count <= maxCount)
      .sort((a, b) => b.count - a.count)

    for (const s of candidates) {
      if (this.findLowestInteriorHole(s.start, s.count)) return s
    }
    return undefined
  }

  private findLowestInteriorHole (
    sectionStart: number,
    count: number,
  ): { start: number, count: number, index: number } | undefined {
    for (let i = 0; i < this.freeList.length; i++) {
      const slot = this.freeList[i]!
      if (slot.start < sectionStart && slot.count >= count) {
        return { start: slot.start, count: slot.count, index: i }
      }
    }
    return undefined
  }

  private reserveFreeSlotAt (index: number, count: number): { start: number, count: number } {
    const slot = this.freeList[index]!
    this.freeList.splice(index, 1)
    if (slot.count === count) return { start: slot.start, count }
    const used = { start: slot.start, count }
    this.insertFreeSlot({ start: slot.start + count, count: slot.count - count })
    return used
  }

  private copySectionRange (oldStart: number, newStart: number, count: number): void {
    this.w0.copyWithin(newStart, oldStart, oldStart + count)
    this.w1.copyWithin(newStart, oldStart, oldStart + count)
    this.w2.copyWithin(newStart, oldStart, oldStart + count)
    this.w3.copyWithin(newStart, oldStart, oldStart + count)
  }

  private rangeFullyUploaded (start: number, end: number): boolean {
    for (const r of this.pendingRanges) {
      if (r.start <= end && r.end >= start) return false
    }
    return true
  }

  private finalizePendingMove (): void {
    const move = this.pendingMove
    if (!move) return

    const { oldStart, count } = move
    for (let i = oldStart; i < oldStart + count; i++) {
      this.w0[i] = 0
      this.w1[i] = 0
      this.w2[i] = EMPTY_W2
      this.w3[i] = 0
    }
    this.insertFreeSlot({ start: oldStart, count })
    this.shrinkHighWatermark()
    if (oldStart < this.highWatermark) {
      this.markDirty(oldStart, oldStart + count - 1)
    }
    this.mesh.geometry.instanceCount = this.highWatermark
    this.pendingMove = null
  }

  private shrinkHighWatermark (): void {
    while (this.highWatermark > 0) {
      const tail = this.highWatermark - 1
      const free = this.freeList.find(s => s.start <= tail && s.start + s.count > tail)
      if (!free || free.start + free.count !== this.highWatermark) break
      this.highWatermark = free.start
      const idx = this.freeList.indexOf(free)
      this.freeList.splice(idx, 1)
    }
  }

  private growCapacity (minFaces: number): void {
    // Moved CPU data at newStart survives nw*.set(); pendingRanges cleared below anyway.
    if (this.pendingMove) this.finalizePendingMove()

    console.warn('[globalBlockBuffer] growing faces', this.capacityFaces, '->', '(need', minFaces, ')')
    let newCap = this.capacityFaces
    while (newCap < minFaces) newCap += GROWTH_INCREMENT_FACES
    console.warn('[globalBlockBuffer] growing faces', this.capacityFaces, '->', newCap)

    const nw0 = new Uint32Array(newCap)
    const nw1 = new Uint32Array(newCap)
    const nw2 = new Uint32Array(newCap)
    const nw3 = new Uint32Array(newCap)
    nw0.set(this.w0)
    nw1.set(this.w1)
    nw2.set(this.w2)
    nw3.set(this.w3)
    nw2.fill(EMPTY_W2, this.w0.length)

    this.w0 = nw0
    this.w1 = nw1
    this.w2 = nw2
    this.w3 = nw3
    this.capacityFaces = newCap

    const geometry = this.mesh.geometry
    const mkAttr = (arr: Uint32Array, name: string) => {
      const prev = geometry.getAttribute(name)
      if (prev) {
        geometry.deleteAttribute(name)
        if ('dispose' in prev && typeof (prev as { dispose?: () => void }).dispose === 'function') {
          (prev as { dispose: () => void }).dispose()
        }
      }
      const attr = new THREE.InstancedBufferAttribute(arr, 1)
      attr.setUsage(THREE.DynamicDrawUsage)
      geometry.setAttribute(name, attr)
    }
    mkAttr(this.w0, 'a_w0')
    mkAttr(this.w1, 'a_w1')
    mkAttr(this.w2, 'a_w2')
    mkAttr(this.w3, 'a_w3')

    this.pendingRanges.length = 0
  }
}
