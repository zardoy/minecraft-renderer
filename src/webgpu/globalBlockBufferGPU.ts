/**
 * GPU-resident global block buffer for the WebGPU backend.
 *
 * Mirrors the slot-allocator semantics of `three/globalBlockBuffer.ts` (per-sectionKey
 * add/remove, free list, linear growth, bounded per-frame uploads) but differs in two
 * ways that matter for performance:
 *
 *  1. **Interleaved storage.** Faces are stored as `uvec4` exactly as the mesher emits
 *     them, so `addSection` is a single `set()` memcpy instead of the WebGL path's
 *     per-face de-interleave into 4 planar arrays. This is the main main-thread win.
 *  2. **Section metadata is GPU-visible.** Each occupied slot publishes
 *     (sectionX, sectionY, sectionZ, faceStart, faceCount) so the culling compute pass
 *     can frustum-test sections and compact visible faces entirely on the GPU — the CPU
 *     never builds a visible-span list.
 *
 * Growth is linear (not doubling) to keep iOS allocation spikes bounded to one increment,
 * matching the rationale in the WebGL implementation.
 */

import * as THREE from 'three/webgpu'
import { packWord2Empty } from '../wasm-mesher/bridge/shaderCubeBridge'

export const WORDS_PER_FACE = 4
export const BYTES_PER_FACE = WORDS_PER_FACE * 4

const INITIAL_CAPACITY_FACES = 512_000
const GROWTH_INCREMENT_FACES = 1_000_000
const MAX_UPLOAD_FACES_PER_FRAME = 15_000
const FRAGMENTATION_THRESHOLD = 0.25

/** Fields per section metadata record: sx, sy, sz, faceStart, faceCount, _pad0..2 (16 B align). */
export const SECTION_META_STRIDE = 8

const EMPTY_W2 = packWord2Empty()

type Slot = { start: number; count: number; metaIndex: number }

export type GlobalBlockBufferGPUOptions = {
  initialCapacityFaces?: number
  maxSections?: number
  /** Clamp derived from adapter limits; see `maxFacesForLimits`. */
  maxCapacityFaces?: number
}

export class GlobalBlockBufferGPU {
  /** Interleaved uvec4 face words — bound as a read-only storage buffer in the shader. */
  faceWords: THREE.StorageBufferAttribute
  /** (sx, sy, sz, faceStart, faceCount, pad, pad, pad) per section slot. */
  sectionMeta: THREE.StorageBufferAttribute
  /** Compacted visible face indices, written by the cull pass. Sized to capacity. */
  visibleFaces: THREE.StorageBufferAttribute

  private capacityFaces: number
  private readonly maxCapacityFaces: number
  private readonly maxSections: number

  private words: Uint32Array
  private meta: Int32Array

  private readonly sectionSlots = new Map<string, Slot>()
  private freeList: Array<{ start: number; count: number }> = []
  private freeMetaIndices: number[] = []
  private metaHighWatermark = 0
  private highWatermark = 0

  private dirtyFaceRanges: Array<{ start: number; end: number }> = []
  private metaDirty = true

  /** Number of section slots the cull pass must dispatch over. */
  get sectionDispatchCount(): number {
    return this.metaHighWatermark
  }

  get usedFaces(): number {
    return this.highWatermark
  }

  get capacity(): number {
    return this.capacityFaces
  }

  constructor(opts: GlobalBlockBufferGPUOptions = {}) {
    this.capacityFaces = opts.initialCapacityFaces ?? INITIAL_CAPACITY_FACES
    this.maxCapacityFaces = opts.maxCapacityFaces ?? Number.POSITIVE_INFINITY
    this.maxSections = opts.maxSections ?? 32_768

    this.words = new Uint32Array(this.capacityFaces * WORDS_PER_FACE)
    this.fillEmpty(this.words, 0, this.capacityFaces)

    this.meta = new Int32Array(this.maxSections * SECTION_META_STRIDE)

    this.faceWords = new THREE.StorageBufferAttribute(this.words, WORDS_PER_FACE)
    this.sectionMeta = new THREE.StorageBufferAttribute(this.meta, SECTION_META_STRIDE)
    this.visibleFaces = new THREE.StorageBufferAttribute(new Uint32Array(this.capacityFaces), 1)
  }

  /** Stamp the empty-slot sentinel into word2 across a face range. */
  private fillEmpty(target: Uint32Array, startFace: number, countFaces: number): void {
    for (let f = 0; f < countFaces; f++) {
      target[(startFace + f) * WORDS_PER_FACE + 2] = EMPTY_W2
    }
  }

  /**
   * Insert or replace a section's faces.
   *
   * @param words interleaved uvec4 words straight from the mesher (length >= faceCount*4)
   */
  addSection(sectionKey: string, words: Uint32Array, faceCount: number, sx: number, sy: number, sz: number): boolean {
    const existing = this.sectionSlots.get(sectionKey)
    if (existing) {
      if (existing.count === faceCount) {
        // Same size — overwrite in place, no allocator churn.
        this.words.set(words.subarray(0, faceCount * WORDS_PER_FACE), existing.start * WORDS_PER_FACE)
        this.writeMeta(existing.metaIndex, sx, sy, sz, existing.start, faceCount)
        this.markFaceDirty(existing.start, existing.start + faceCount)
        return true
      }
      this.removeSection(sectionKey)
    }

    if (faceCount === 0) return true

    const alloc = this.allocate(faceCount)
    if (!alloc) return false

    const metaIndex = this.freeMetaIndices.pop() ?? this.metaHighWatermark++
    if (metaIndex >= this.maxSections) {
      this.release(alloc.start, faceCount)
      return false
    }

    this.words.set(words.subarray(0, faceCount * WORDS_PER_FACE), alloc.start * WORDS_PER_FACE)
    this.sectionSlots.set(sectionKey, { start: alloc.start, count: faceCount, metaIndex })
    this.writeMeta(metaIndex, sx, sy, sz, alloc.start, faceCount)
    this.markFaceDirty(alloc.start, alloc.start + faceCount)
    return true
  }

  removeSection(sectionKey: string): void {
    const slot = this.sectionSlots.get(sectionKey)
    if (!slot) return
    this.sectionSlots.delete(sectionKey)

    // Zero the metadata so the cull pass skips it (faceCount = 0).
    this.writeMeta(slot.metaIndex, 0, 0, 0, 0, 0)
    this.freeMetaIndices.push(slot.metaIndex)

    this.fillEmpty(this.words, slot.start, slot.count)
    this.markFaceDirty(slot.start, slot.start + slot.count)
    this.release(slot.start, slot.count)
  }

  private writeMeta(metaIndex: number, sx: number, sy: number, sz: number, faceStart: number, faceCount: number): void {
    const o = metaIndex * SECTION_META_STRIDE
    this.meta[o] = sx
    this.meta[o + 1] = sy
    this.meta[o + 2] = sz
    this.meta[o + 3] = faceStart
    this.meta[o + 4] = faceCount
    this.metaDirty = true
  }

  private allocate(count: number): { start: number } | null {
    // First fit over the free list; exact fits preferred to limit fragmentation.
    let bestIndex = -1
    for (const [i, block] of this.freeList.entries()) {
      if (block.count === count) {
        bestIndex = i
        break
      }
      if (block.count > count && bestIndex === -1) bestIndex = i
    }

    if (bestIndex !== -1) {
      const block = this.freeList[bestIndex]
      const start = block.start
      if (block.count === count) {
        this.freeList.splice(bestIndex, 1)
      } else {
        block.start += count
        block.count -= count
      }
      return { start }
    }

    if (this.highWatermark + count > this.capacityFaces) {
      if (!this.grow(count)) return null
    }

    const start = this.highWatermark
    this.highWatermark += count
    return { start }
  }

  private release(start: number, count: number): void {
    this.freeList.push({ start, count })
    if (start + count === this.highWatermark) {
      // Trailing block — reclaim directly and coalesce backwards.
      this.freeList.pop()
      this.highWatermark = start
      this.coalesceTrailing()
    }
  }

  private coalesceTrailing(): void {
    let changed = true
    while (changed) {
      changed = false
      for (const [i, b] of this.freeList.entries()) {
        if (b.start + b.count === this.highWatermark) {
          this.highWatermark = b.start
          this.freeList.splice(i, 1)
          changed = true
          break
        }
      }
    }
  }

  /** Linear growth; returns false when the adapter's storage limit is reached. */
  private grow(needed: number): boolean {
    let next = this.capacityFaces
    while (this.highWatermark + needed > next) next += GROWTH_INCREMENT_FACES
    if (next > this.maxCapacityFaces) return false

    const words = new Uint32Array(next * WORDS_PER_FACE)
    words.set(this.words)
    this.fillEmpty(words, this.capacityFaces, next - this.capacityFaces)

    this.words = words
    this.capacityFaces = next

    // Storage attributes must be recreated; the renderer rebuilds bind groups on change.
    this.faceWords = new THREE.StorageBufferAttribute(this.words, WORDS_PER_FACE)
    this.visibleFaces = new THREE.StorageBufferAttribute(new Uint32Array(next), 1)
    this.dirtyFaceRanges = [{ start: 0, end: this.highWatermark }]
    return true
  }

  private markFaceDirty(start: number, end: number): void {
    this.dirtyFaceRanges.push({ start, end })
  }

  get fragmentation(): number {
    if (this.highWatermark === 0) return 0
    const free = this.freeList.reduce((sum, b) => sum + b.count, 0)
    return free / this.highWatermark
  }

  get needsCompaction(): boolean {
    return this.fragmentation > FRAGMENTATION_THRESHOLD
  }

  /**
   * Flush pending CPU writes to the GPU, bounded to `MAX_UPLOAD_FACES_PER_FRAME`.
   * Returns true when work remains for a later frame.
   */
  flushUploads(maxFaces = MAX_UPLOAD_FACES_PER_FRAME): boolean {
    if (this.metaDirty) {
      this.sectionMeta.needsUpdate = true
      this.metaDirty = false
    }
    if (this.dirtyFaceRanges.length === 0) return false

    // Merge overlapping/adjacent ranges so one upload covers contiguous edits.
    this.dirtyFaceRanges.sort((a, b) => a.start - b.start)
    const merged: Array<{ start: number; end: number }> = []
    for (const r of this.dirtyFaceRanges) {
      const last = merged.at(-1)
      if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
      else merged.push({ ...r })
    }

    let budget = maxFaces
    const remaining: Array<{ start: number; end: number }> = []
    let lo = Number.POSITIVE_INFINITY
    let hi = 0

    for (const r of merged) {
      if (budget <= 0) {
        remaining.push(r)
        continue
      }
      const take = Math.min(r.end - r.start, budget)
      lo = Math.min(lo, r.start)
      hi = Math.max(hi, r.start + take)
      budget -= take
      if (r.start + take < r.end) remaining.push({ start: r.start + take, end: r.end })
    }

    if (hi > lo) {
      // three uploads the whole attribute on needsUpdate; addUpdateRange narrows it.
      this.faceWords.clearUpdateRanges?.()
      this.faceWords.addUpdateRange?.(lo * WORDS_PER_FACE, (hi - lo) * WORDS_PER_FACE)
      this.faceWords.needsUpdate = true
    }

    this.dirtyFaceRanges = remaining
    return remaining.length > 0
  }

  hasSection(sectionKey: string): boolean {
    return this.sectionSlots.has(sectionKey)
  }

  get sectionCount(): number {
    return this.sectionSlots.size
  }

  dispose(): void {
    this.sectionSlots.clear()
    this.freeList = []
    this.freeMetaIndices = []
    this.highWatermark = 0
    this.metaHighWatermark = 0
    this.dirtyFaceRanges = []
  }

  /** Bytes of CPU-side backing store — surfaced to the iOS memory harness. */
  get cpuBytes(): number {
    return this.words.byteLength + this.meta.byteLength
  }
}
