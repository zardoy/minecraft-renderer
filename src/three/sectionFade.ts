import * as THREE from 'three'
import { SECTION_FADE_RING, SECTION_FADE_Y } from './shaders/sectionFadeGlsl'

/** texels along x: 4 sections per RGBA texel */
const TEX_WIDTH = SECTION_FADE_RING / 4
const TEX_HEIGHT = SECTION_FADE_RING * SECTION_FADE_Y

/**
 * When each section was first shown, for the fade-in (see shaders/sectionFadeGlsl.ts). One float per section in a ring
 * texture addressed by world section coordinates; 0 = never faded (shown fully). A section fades once per load: remeshes
 * keep it shown, unloading it forgets it (a reloaded section fades again, like vanilla's per-RenderSection uploadedTime).
 * Showing a section uploads one texel.
 */
export class SectionFade {
  readonly texture: THREE.DataTexture
  private readonly data: Float32Array
  /** sections whose start time is written for this load */
  private readonly shown = new Set<string>()
  /**
   * Start time per column ("x,z" in blocks): a column is revealed at once, so every section takes its column's start. A section that
   * gets its first mesh after the column was revealed joins in sync (or shows fully if the column is done), never fading on its own
   * (with the futuristic look a late section would show only edges under a finished one: blocks standing on air).
   */
  private readonly columnStart = new Map<string, number>()
  private readonly epoch = performance.now()
  private minSectionY = 0

  constructor() {
    this.data = new Float32Array(TEX_WIDTH * TEX_HEIGHT * 4)
    this.texture = new THREE.DataTexture(this.data, TEX_WIDTH, TEX_HEIGHT, THREE.RGBAFormat, THREE.FloatType)
    this.texture.magFilter = THREE.NearestFilter
    this.texture.minFilter = THREE.NearestFilter
    this.texture.generateMipmaps = false
    this.texture.needsUpdate = true
  }

  /** seconds since the epoch, +1 so a start time is never 0 (0 = not fading) */
  now(nowMs = performance.now()): number {
    return (nowMs - this.epoch) / 1000 + 1
  }

  setMinSectionY(minY: number): void {
    this.minSectionY = Math.floor(minY / 16)
  }

  /** The section with world origin key "x,y,z" (blocks) became visible: it fades in with its column, once per load. */
  sectionShown(sectionKey: string, nowMs = performance.now()): void {
    if (this.shown.has(sectionKey)) return
    this.shown.add(sectionKey)
    const [x, , z] = sectionKey.split(',')
    const column = `${x},${z}`
    let start = this.columnStart.get(column)
    if (start === undefined) {
      start = this.now(nowMs)
      this.columnStart.set(column, start)
    }
    const index = this.componentIndex(sectionKey)
    if (index === undefined) return
    this.data[index] = start
    this.texture.addUpdateRange(index, 1)
    this.texture.needsUpdate = true
  }

  /** The section was removed (unloaded, or now empty): when it is shown again it takes its column's start again. */
  sectionForgotten(sectionKey: string): void {
    this.shown.delete(sectionKey)
  }

  /** The column was unloaded: when it comes back it fades in again. */
  columnForgotten(chunkX: number, chunkZ: number): void {
    this.columnStart.delete(`${chunkX},${chunkZ}`)
  }

  /** world switch: nothing is faded any more */
  reset(): void {
    this.shown.clear()
    this.columnStart.clear()
    this.data.fill(0)
    // whole texture: pending single-texel ranges would limit the upload to them
    this.texture.clearUpdateRanges()
    this.texture.needsUpdate = true
  }

  dispose(): void {
    this.texture.dispose()
  }

  /** component of the section's start time in `data`, undefined when outside the stored y range */
  componentIndex(sectionKey: string): number | undefined {
    const [x, y, z] = sectionKey.split(',').map(Number) as [number, number, number]
    const sy = Math.floor(y / 16) - this.minSectionY
    if (!(sy >= 0 && sy < SECTION_FADE_Y)) return undefined
    const sx = Math.floor(x / 16) & (SECTION_FADE_RING - 1)
    const sz = Math.floor(z / 16) & (SECTION_FADE_RING - 1)
    const texel = (sz * SECTION_FADE_Y + sy) * TEX_WIDTH + (sx >> 2)
    return texel * 4 + (sx & 3)
  }
}
