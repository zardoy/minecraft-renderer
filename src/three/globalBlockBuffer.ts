import * as THREE from 'three'
import type { CubeDrawSpan } from './cubeDrawSpans'
import {
  createCubeMultiDrawScratch,
  detectMultiDrawCaps,
  drawCubeSpans,
  logMultiDrawTierOnce,
  type CubeMultiDrawScratch,
  type MultiDrawCaps,
} from './cubeMultiDraw'
import { VERTICES_PER_FACE, computeSectionOriginRel } from './shaders/cubeBlockShader'
import { computeCameraRelativeUniforms, type RenderOrigin } from './shaders/legacyBlockShader'
import { packWord2Empty } from '../wasm-mesher/bridge/shaderCubeBridge'

type WebGLRendererInternals = THREE.WebGLRenderer & {
  properties: {
    get: (material: THREE.Material) => { currentProgram: { program: WebGLProgram } }
  }
}

type TierCAttrBinding = { loc: number, buffer: WebGLBuffer }
type TierCAttrState = {
  w0: TierCAttrBinding
  w1: TierCAttrBinding
  w2: TierCAttrBinding
  w3: TierCAttrBinding
}

// Linear growth (NOT doubling) to keep iOS allocation spikes bounded to one increment.
// Reference: prismarine-web-client PR #90 (webgl) and #120 (webgpu) both grow by +1M faces.
const INITIAL_CAPACITY_FACES = 512_000      // ~8 MB up front (4 words × 4 B), well under 1M
const GROWTH_INCREMENT_FACES = 1_000_000    // +16 MB per growth step instead of doubling
const MAX_UPLOAD_FACES_PER_FRAME = 15_000   // face-indexed budget (chunksStorage uses 10k blocks)
const FRAGMENTATION_THRESHOLD = 0.25
const EMPTY_W2 = packWord2Empty()

/** CPU bytes per instanced cube face (a_w0..a_w3). */
export const SHADER_CUBE_BYTES_PER_FACE = 16

type PendingMove = { key: string, oldStart: number, newStart: number, count: number }
type PendingReplace = { oldStart: number, oldCount: number }

export type GlobalBlockBufferShaderData = {
  words: Uint32Array
  count: number
}

/**
 * Single GPU instanced mesh for all shader-cube faces in the world.
 * Camera-relative positioning via u_originDelta + u_sectionOriginRel; no sceneOrigin tracking.
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
  private readonly pendingReplace = new Map<string, PendingReplace>()
  private uploadEpoch = 0
  private visibleSpans: CubeDrawSpan[] = []
  private readonly _drawScratch: CubeMultiDrawScratch = createCubeMultiDrawScratch()
  private multiDrawCaps: MultiDrawCaps | null = null
  private tierCVao: WebGLVertexArrayObject | null = null
  private tierCAttrs: TierCAttrState | null = null
  private tierCGl: WebGL2RenderingContext | null = null
  private debugOverlay = false
  private layoutVersion = 0

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

    this.mesh.onAfterRender = (renderer, _scene, _camera, _geometry, material) => {
      if (this.visibleSpans.length === 0) return
      const shaderMaterial = material as THREE.ShaderMaterial
      const gl = renderer.getContext() as WebGL2RenderingContext
      if (!this.multiDrawCaps) {
        this.multiDrawCaps = detectMultiDrawCaps(gl)
        logMultiDrawTierOnce(this.multiDrawCaps.tier, this.debugOverlay)
      }
      drawCubeSpans(
        gl,
        this.multiDrawCaps,
        this.visibleSpans,
        this._drawScratch,
        this.multiDrawCaps.tier === 'C'
          ? (g, spans) => this.drawTierCSpans(g, spans, renderer, shaderMaterial)
          : undefined,
      )
    }
  }

  setDebugOverlay (enabled: boolean): void {
    this.debugOverlay = enabled
  }

  /**
   * Suppress three's full-buffer instanced draw; onAfterRender issues visible spans only.
   * setDrawRange(0,0) skips bindingStates.setup in r0.184 — use 6 verts + instanceCount=0
   * so program/VAO stay bound while renderInstances no-ops at primcount===0.
   */
  suppressThreeDraw (): void {
    const geometry = this.mesh.geometry
    geometry.setDrawRange(0, VERTICES_PER_FACE)
    geometry.instanceCount = 0
  }

  setVisibleSpans (spans: CubeDrawSpan[]): void {
    this.visibleSpans = spans
  }

  getVisibleSpans (): readonly CubeDrawSpan[] {
    return this.visibleSpans
  }

  forEachSectionSlot (cb: (key: string, slot: { start: number, count: number }) => void): void {
    for (const [key, slot] of this.sectionSlots) {
      cb(key, slot)
    }
  }

  getSectionDrawStart (sectionKey: string): number | undefined {
    const slot = this.sectionSlots.get(sectionKey)
    if (!slot) return undefined
    if (this.pendingMove?.key === sectionKey) return this.pendingMove.oldStart
    const replace = this.pendingReplace.get(sectionKey)
    if (replace) return replace.oldStart
    if (!this.rangeFullyUploaded(slot.start, slot.start + slot.count - 1)) return undefined
    return slot.start
  }

  getSectionDrawCount (sectionKey: string): number | undefined {
    const slot = this.sectionSlots.get(sectionKey)
    if (!slot) return undefined
    if (this.pendingMove?.key === sectionKey) return this.pendingMove.count
    const replace = this.pendingReplace.get(sectionKey)
    if (replace) return replace.oldCount
    if (!this.rangeFullyUploaded(slot.start, slot.start + slot.count - 1)) return undefined
    return slot.count
  }

  getUploadEpoch (): number {
    return this.uploadEpoch
  }

  hasPendingReplace (): boolean {
    return this.pendingReplace.size > 0
  }

  canUseFullDrawShortcut (): boolean {
    return this.pendingRanges.length === 0
      && this.interiorFreeFaces() === 0
      && this.pendingMove === null
      && this.pendingReplace.size === 0
  }

  isRangeFullyUploaded (start: number, end: number): boolean {
    return this.rangeFullyUploaded(start, end)
  }

  getPendingDirtyRanges (): ReadonlyArray<{ start: number, end: number }> {
    return this.pendingRanges
  }

  getHighWatermark (): number {
    return this.highWatermark
  }

  getCapacityFaces (): number {
    return this.capacityFaces
  }

  getSectionCount (): number {
    return this.sectionSlots.size
  }

  getMemoryBytes (): number {
    return this.capacityFaces * SHADER_CUBE_BYTES_PER_FACE
  }

  getUsedMemoryBytes (): number {
    return this.highWatermark * SHADER_CUBE_BYTES_PER_FACE
  }

  hasPendingUploads (): boolean {
    return this.pendingRanges.length > 0
  }

  getPendingMove (): PendingMove | null {
    return this.pendingMove
  }

  addSection (sectionKey: string, words: Uint32Array, faceCount: number): void {
    if (faceCount <= 0) {
      this.removeSection(sectionKey)
      return
    }

    const isRemesh = this.sectionSlots.has(sectionKey)
    let previousSlot: { start: number, count: number } | undefined
    if (isRemesh) {
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
      previousSlot = this.sectionSlots.get(sectionKey)!
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
    if (isRemesh && previousSlot) {
      this.pendingReplace.set(sectionKey, { oldStart: previousSlot.start, oldCount: previousSlot.count })
    }
    this.markDirty(slot.start, slot.start + faceCount - 1)
    this.mesh.geometry.instanceCount = this.highWatermark
    this.layoutVersion++
  }

  getLayoutVersion (): number {
    return this.layoutVersion
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
    this.layoutVersion++
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

    for (const key of [...this.pendingReplace.keys()]) {
      const slot = this.sectionSlots.get(key)
      if (!slot) continue
      if (this.rangeFullyUploaded(slot.start, slot.start + slot.count - 1)) {
        this.finalizePendingReplace(key)
      }
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
    this.layoutVersion++
  }

  uploadDirtyRange (): void {
    const r = this.pendingRanges[0]
    if (!r) return

    const offset = r.start
    const count = Math.min(r.end - r.start + 1, MAX_UPLOAD_FACES_PER_FRAME)
    const geometry = this.mesh.geometry

    for (const name of ['a_w0', 'a_w1', 'a_w2', 'a_w3'] as const) {
      const attr = geometry.getAttribute(name) as THREE.InstancedBufferAttribute
      attr.clearUpdateRanges()
      attr.addUpdateRange(offset, count)
      attr.needsUpdate = true
    }

    if (offset + count > r.end) {
      this.pendingRanges.shift()
    } else {
      r.start = offset + count
    }
    this.uploadEpoch++
  }

  setCameraOrigin (renderOrigin: RenderOrigin, x: number, y: number, z: number): void {
    const { originDelta, cameraOriginFrac } = computeCameraRelativeUniforms(renderOrigin, x, y, z)
    const sectionOriginRel = computeSectionOriginRel(renderOrigin)
    const u = this.mesh.material.uniforms.u_originDelta
    if (u?.value?.set) {
      u.value.set(originDelta.x, originDelta.y, originDelta.z)
    }
    const uf = this.mesh.material.uniforms.u_cameraOriginFrac
    if (uf?.value?.set) {
      uf.value.set(cameraOriginFrac.x, cameraOriginFrac.y, cameraOriginFrac.z)
    }
    const us = this.mesh.material.uniforms.u_sectionOriginRel
    if (us?.value?.set) {
      us.value.set(sectionOriginRel.x, sectionOriginRel.y, sectionOriginRel.z)
    }
  }

  reset (): void {
    this.sectionSlots.clear()
    this.freeList.length = 0
    this.highWatermark = 0
    this.pendingRanges.length = 0
    this.pendingMove = null
    this.pendingReplace.clear()
    this.uploadEpoch = 0
    this.visibleSpans = []
    this.w0.fill(0)
    this.w1.fill(0)
    this.w2.fill(EMPTY_W2)
    this.w3.fill(0)
    this.mesh.geometry.instanceCount = 0
    this.invalidateTierCVao()
  }

  dispose (): void {
    this.invalidateTierCVao()
    this.mesh.parent?.remove(this.mesh)
    this.mesh.geometry.dispose()
    this.reset()
  }

  private invalidateTierCVao (): void {
    if (this.tierCVao && this.tierCGl) {
      this.tierCGl.deleteVertexArray(this.tierCVao)
    }
    this.tierCVao = null
    this.tierCAttrs = null
  }

  private drawTierCSpans (
    gl: WebGL2RenderingContext,
    spans: readonly CubeDrawSpan[],
    renderer: THREE.WebGLRenderer,
    material: THREE.ShaderMaterial,
  ): void {
    this.ensureTierCVao(gl, renderer, material)
    if (!this.tierCVao || !this.tierCAttrs) return

    const attrs = this.tierCAttrs
    gl.bindVertexArray(this.tierCVao)
    for (const span of spans) {
      const byteOffset = span.start * 4
      const repointWord = (binding: TierCAttrBinding) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, binding.buffer)
        gl.vertexAttribIPointer(binding.loc, 1, gl.UNSIGNED_INT, 4, byteOffset)
      }
      repointWord(attrs.w0)
      repointWord(attrs.w1)
      repointWord(attrs.w2)
      repointWord(attrs.w3)
      gl.drawArraysInstanced(gl.TRIANGLES, 0, VERTICES_PER_FACE, span.count)
    }
    gl.bindVertexArray(null)
  }

  private ensureTierCVao (
    gl: WebGL2RenderingContext,
    renderer: THREE.WebGLRenderer,
    material: THREE.ShaderMaterial,
  ): void {
    this.tierCGl = gl
    const internals = renderer as WebGLRendererInternals
    const materialProps = internals.properties.get(material) as { currentProgram: { program: WebGLProgram } }
    const program = materialProps.currentProgram.program

    const w0Loc = gl.getAttribLocation(program, 'a_w0')
    const w1Loc = gl.getAttribLocation(program, 'a_w1')
    const w2Loc = gl.getAttribLocation(program, 'a_w2')
    const w3Loc = gl.getAttribLocation(program, 'a_w3')

    const readBoundBuffer = (loc: number): WebGLBuffer | null => {
      if (loc < 0) return null
      return gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING) as WebGLBuffer | null
    }

    const liveW0 = readBoundBuffer(w0Loc)
    if (this.tierCVao && this.tierCAttrs && liveW0 && this.tierCAttrs.w0.buffer !== liveW0) {
      this.invalidateTierCVao()
    }
    if (this.tierCVao) return

    const w0Buf = readBoundBuffer(w0Loc)
    const w1Buf = readBoundBuffer(w1Loc)
    const w2Buf = readBoundBuffer(w2Loc)
    const w3Buf = readBoundBuffer(w3Loc)
    if (!w0Buf || !w1Buf || !w2Buf || !w3Buf) return

    const vao = gl.createVertexArray()
    if (!vao) return

    gl.bindVertexArray(vao)

    const bindInstancedWord = (loc: number, buffer: WebGLBuffer) => {
      gl.enableVertexAttribArray(loc)
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.vertexAttribIPointer(loc, 1, gl.UNSIGNED_INT, 4, 0)
      gl.vertexAttribDivisor(loc, 1)
    }
    bindInstancedWord(w0Loc, w0Buf)
    bindInstancedWord(w1Loc, w1Buf)
    bindInstancedWord(w2Loc, w2Buf)
    bindInstancedWord(w3Loc, w3Buf)

    gl.bindVertexArray(null)
    this.tierCVao = vao
    this.tierCAttrs = {
      w0: { loc: w0Loc, buffer: w0Buf },
      w1: { loc: w1Loc, buffer: w1Buf },
      w2: { loc: w2Loc, buffer: w2Buf },
      w3: { loc: w3Loc, buffer: w3Buf },
    }
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

  private zeroAndFreeSlot (start: number, count: number): void {
    for (let i = start; i < start + count; i++) {
      this.w0[i] = 0
      this.w1[i] = 0
      this.w2[i] = EMPTY_W2
      this.w3[i] = 0
    }
    this.markDirty(start, start + count - 1)
    this.insertFreeSlot({ start, count })
  }

  private finalizePendingReplace (key: string): void {
    const pr = this.pendingReplace.get(key)
    if (!pr) return

    this.zeroAndFreeSlot(pr.oldStart, pr.oldCount)
    this.pendingReplace.delete(key)
    this.shrinkHighWatermark()
    this.mesh.geometry.instanceCount = this.highWatermark
    this.layoutVersion++
    this.uploadEpoch++
  }

  private finalizePendingMove (): void {
    const move = this.pendingMove
    if (!move) return

    const { oldStart, count } = move
    this.zeroAndFreeSlot(oldStart, count)
    this.shrinkHighWatermark()
    this.mesh.geometry.instanceCount = this.highWatermark
    this.pendingMove = null
    this.layoutVersion++
    this.uploadEpoch++
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
    for (const key of [...this.pendingReplace.keys()]) {
      this.finalizePendingReplace(key)
    }

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
    this.invalidateTierCVao()
  }
}
