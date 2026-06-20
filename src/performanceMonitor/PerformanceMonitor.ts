import {
  CONSTANT_LONG_RENDER_FRACTION,
  CONSTANT_LONG_RENDER_MIN_SAMPLES,
  FAST_SCENE_WITHOUT_ENTITIES_MS,
  HIGH_TEXTURE_COUNT,
  LONG_RENDER_TIME_MS,
  LOW_FPS_THRESHOLD,
  RENDER_TIME_HISTORY_SIZE,
  SLOW_ENTITIES_RENDER_MS
} from './constants'
import type { FramePerformanceSample, PerformanceInstabilityFactors } from './types'

/**
 * Tracks render/FPS signals and writes instability factors into reactive state
 * (alongside `mesherWork`).
 */
export class PerformanceMonitor {
  private readonly renderTimeHistory: number[] = []

  constructor(private readonly factors: PerformanceInstabilityFactors) {}

  onFrame(sample: FramePerformanceSample): void {
    this.pushRenderTime(sample.totalMs)
    this.recompute(sample)
  }

  private pushRenderTime(ms: number): void {
    this.renderTimeHistory.push(ms)
    if (this.renderTimeHistory.length > RENDER_TIME_HISTORY_SIZE) {
      this.renderTimeHistory.shift()
    }
  }

  private recompute(sample: FramePerformanceSample): void {
    const lowFps = sample.fps > 0 && sample.fps <= LOW_FPS_THRESHOLD
    const sceneWithoutEntitiesMs = Math.max(0, sample.totalMs - sample.entitiesMs)

    const longRenderTime = sample.totalMs >= LONG_RENDER_TIME_MS

    const historyLen = this.renderTimeHistory.length
    const longFrames = this.renderTimeHistory.filter(t => t >= LONG_RENDER_TIME_MS).length
    const constantLongRenderTime = historyLen >= CONSTANT_LONG_RENDER_MIN_SAMPLES && longFrames / historyLen >= CONSTANT_LONG_RENDER_FRACTION

    const tooManyTextures = sample.loadedTextureCount >= HIGH_TEXTURE_COUNT

    const tooManyEntities = lowFps && sample.entitiesMs >= SLOW_ENTITIES_RENDER_MS && sceneWithoutEntitiesMs <= FAST_SCENE_WITHOUT_ENTITIES_MS

    const hasKnownCause = longRenderTime || constantLongRenderTime || tooManyEntities || tooManyTextures

    const unknownReason = lowFps && !hasKnownCause

    this.factors.longRenderTime = longRenderTime
    this.factors.constantLongRenderTime = constantLongRenderTime
    this.factors.tooManyEntities = tooManyEntities
    this.factors.tooManyTextures = tooManyTextures
    this.factors.unknownReason = unknownReason
  }

  reset(): void {
    this.renderTimeHistory.length = 0
    this.factors.longRenderTime = false
    this.factors.constantLongRenderTime = false
    this.factors.tooManyEntities = false
    this.factors.tooManyTextures = false
    this.factors.unknownReason = false
  }
}
