import * as THREE from 'three'
import { VERTICES_PER_FACE } from './shaders/cubeBlockShader'
import { packWord2Empty } from '../wasm-mesher/bridge/shaderCubeBridge'

const INITIAL_CAPACITY_FACES = 2_000_000
const EMPTY_W2 = packWord2Empty()

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
  private dirtyMin = Infinity
  private dirtyMax = -1

  constructor (
    material: THREE.ShaderMaterial,
    scene: THREE.Object3D,
  ) {
    this.capacityFaces = INITIAL_CAPACITY_FACES
    this.w0 = new Uint32Array(this.capacityFaces)
    this.w1 = new Uint32Array(this.capacityFaces)
    this.w2 = new Uint32Array(this.capacityFaces)
    this.w3 = new Uint32Array(this.capacityFaces)

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

  uploadDirtyRange (): void {
    if (this.dirtyMin > this.dirtyMax) return

    const offset = this.dirtyMin
    const count = this.dirtyMax - this.dirtyMin + 1
    const geometry = this.mesh.geometry

    for (const name of ['a_w0', 'a_w1', 'a_w2', 'a_w3'] as const) {
      const attr = geometry.getAttribute(name) as THREE.InstancedBufferAttribute
      attr.updateRange.offset = offset
      attr.updateRange.count = count
      attr.needsUpdate = true
    }

    this.dirtyMin = Infinity
    this.dirtyMax = -1
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
    this.dirtyMin = Infinity
    this.dirtyMax = -1
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
    if (start < this.dirtyMin) this.dirtyMin = start
    if (end > this.dirtyMax) this.dirtyMax = end
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
    let newCap = this.capacityFaces
    while (newCap < minFaces) newCap *= 2

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

    this.dirtyMin = 0
    this.dirtyMax = this.highWatermark - 1
  }
}
