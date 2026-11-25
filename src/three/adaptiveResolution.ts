/**
 * Adaptive render resolution: lowers the canvas pixel ratio when the GPU can't keep the frame rate, raises it back when there is headroom.
 *
 * Decided from what the frames measure, never from the device: on an iPhone 14 Pro the world ran at a steady 30 FPS with
 * pixel ratio 3 while the frame's JS took ~3 ms (GPU fill bound), and at 60 FPS with pixel ratio 1.5.
 *
 * Every frame gets the rAF interval and the frame's CPU time. Once per window (about a second) it looks at the window:
 * - struggling: median interval above 20 ms (under 50 FPS) while the CPU work is under half of it, so the GPU is the limit;
 *   lowering the resolution would not help a CPU bound frame, it would only blur it
 * - healthy: 90% of the frames inside the 60 Hz budget
 * - windows with a long stall (chunk meshing, GC, a tab switch) are skipped: they say nothing about the GPU
 * Steps down after one struggling window, steps up after several healthy ones. A step up that struggles at once is undone and
 * that scale becomes the ceiling for a while, so it does not bounce between two sizes. Changes are spaced out: each one
 * reallocates the framebuffers.
 */

export interface AdaptiveResolutionOptions {
  /** smallest scale of the base pixel ratio (the result is also kept at or above `minPixelRatio`) */
  minScale?: number
  /** the pixel ratio is never lowered below this (1 = CSS pixels) */
  minPixelRatio?: number
  /** scale factor per step (applies to the pixel ratio, the pixel count changes by its square) */
  step?: number
  /** frames per decision window */
  windowFrames?: number
  /** healthy windows in a row before stepping up */
  healthyWindowsToRaise?: number
  /** ms between two changes */
  minChangeIntervalMs?: number
  /** ms a failed step up stays blocked */
  ceilingHoldMs?: number
}

const DEFAULTS: Required<AdaptiveResolutionOptions> = {
  minScale: 0.4,
  minPixelRatio: 1,
  step: 0.85,
  windowFrames: 45,
  healthyWindowsToRaise: 4,
  minChangeIntervalMs: 2500,
  ceilingHoldMs: 60_000
}

/** a frame interval this long is a stall (loading, GC, background tab), not GPU load */
const STALL_MS = 100
/** under 50 FPS */
const STRUGGLING_MEDIAN_MS = 20
/** frame budget of 60 Hz plus jitter */
const HEALTHY_FRAME_MS = 18
/** a step up that struggles within this time is undone */
const FAILED_RAISE_MS = 4000

const percentile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]

export class AdaptiveResolution {
  /** multiplier of the base pixel ratio, 1 = full */
  scale = 1
  private readonly opts: Required<AdaptiveResolutionOptions>
  private intervals: number[] = []
  private cpu: number[] = []
  private healthyWindows = 0
  private lastChangeAt = -Infinity
  private lastRaiseAt = -Infinity
  private scaleBeforeRaise = 1
  private ceiling = 1
  private ceilingUntil = -Infinity

  constructor(options: AdaptiveResolutionOptions = {}) {
    this.opts = { ...DEFAULTS, ...options }
  }

  reset() {
    this.scale = 1
    this.intervals = []
    this.cpu = []
    this.healthyWindows = 0
    this.lastChangeAt = -Infinity
    this.lastRaiseAt = -Infinity
    this.ceiling = 1
    this.ceilingUntil = -Infinity
  }

  /** lowest scale for this base pixel ratio */
  private floorFor(basePixelRatio: number) {
    return Math.min(1, Math.max(this.opts.minScale, this.opts.minPixelRatio / basePixelRatio))
  }

  /**
   * @param now performance.now()
   * @param intervalMs time since the previous frame started
   * @param cpuMs JS time of this frame (render call included)
   * @param basePixelRatio pixel ratio at full scale (device ratio after the cap)
   * @returns true when `scale` changed
   */
  onFrame(now: number, intervalMs: number, cpuMs: number, basePixelRatio: number): boolean {
    this.intervals.push(intervalMs)
    this.cpu.push(cpuMs)
    if (this.intervals.length < this.opts.windowFrames) return false

    const intervals = this.intervals.sort((a, b) => a - b)
    const cpu = this.cpu.sort((a, b) => a - b)
    this.intervals = []
    this.cpu = []
    if (intervals.at(-1)! > STALL_MS) return false

    const medianInterval = percentile(intervals, 0.5)
    const medianCpu = percentile(cpu, 0.5)
    const gpuBound = medianCpu < medianInterval * 0.5
    const struggling = medianInterval > STRUGGLING_MEDIAN_MS && gpuBound
    const healthy = percentile(intervals, 0.9) <= HEALTHY_FRAME_MS

    const floor = this.floorFor(basePixelRatio)
    if (now > this.ceilingUntil) this.ceiling = 1

    if (struggling) {
      this.healthyWindows = 0
      // a raise that could not hold: go back and keep that size as the ceiling for a while
      if (now - this.lastRaiseAt < FAILED_RAISE_MS && this.scaleBeforeRaise < this.scale) {
        this.ceiling = this.scaleBeforeRaise
        this.ceilingUntil = now + this.opts.ceilingHoldMs
        return this.apply(now, this.scaleBeforeRaise)
      }
      if (now - this.lastChangeAt < this.opts.minChangeIntervalMs || this.scale <= floor) return false
      return this.apply(now, Math.max(floor, this.scale * this.opts.step))
    }

    if (!healthy) {
      this.healthyWindows = 0
      return false
    }
    this.healthyWindows++
    if (this.healthyWindows < this.opts.healthyWindowsToRaise || this.scale >= this.ceiling) return false
    if (now - this.lastChangeAt < this.opts.minChangeIntervalMs) return false
    this.healthyWindows = 0
    this.scaleBeforeRaise = this.scale
    this.lastRaiseAt = now
    return this.apply(now, Math.min(this.ceiling, this.scale / this.opts.step))
  }

  private apply(now: number, scale: number) {
    // snap near-1 values so full resolution is exactly the base ratio again
    const next = scale > 0.98 ? 1 : scale
    if (next === this.scale) return false
    this.scale = next
    this.lastChangeAt = now
    return true
  }
}
