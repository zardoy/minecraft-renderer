import {
  SectionOcclusionGraph,
  buildOcclusionSectionRecord,
  occlusionSectionRecordsEqual,
  type OcclusionRebuildStats,
  type OcclusionUpdateParams
} from './sectionOcclusionGraph'
import { VISIBILITY_SET_ALL_TRUE } from '../../mesher-shared/visibilitySet'

export type { OcclusionSectionRecord, OcclusionUpdateParams } from './sectionOcclusionGraph'

/** Throttle interval for structural occlusion-graph rebuilds (column load / visibility change). */
export const OCCLUSION_REBUILD_INTERVAL_MS = 250

export class SectionOcclusionCull {
  private readonly graph = new SectionOcclusionGraph()
  private readonly registered = new Set<string>()
  private lastVisible = new Set<string>()
  private _lastSmartCull = false
  private structuralDirty = false
  private rebuildPending = false
  private forceImmediateRebuild = false
  private lastRebuildAt = 0
  private lastCameraKey = ''
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly onDeferredRebuild?: () => void) {}

  registerSection(key: string, visibilitySet: number | undefined, sectionHeight: number): void {
    const normalizedVis = visibilitySet ?? VISIBILITY_SET_ALL_TRUE
    const nextRecord = buildOcclusionSectionRecord(key, normalizedVis, sectionHeight)
    const existing = this.graph.getSection(key)
    if (existing !== undefined && occlusionSectionRecordsEqual(existing, nextRecord)) {
      this.registered.add(key)
      return
    }
    this.registered.add(key)
    this.graph.setSection(key, nextRecord)
    this.markStructuralDirty()
  }

  unregisterSection(key: string): void {
    if (!this.registered.delete(key)) return
    this.graph.removeSection(key)
    this.markStructuralDirty()
  }

  invalidate(): void {
    this.forceImmediateRebuild = true
    this.markStructuralDirty()
  }

  clear(): void {
    this.cancelRebuildTimer()
    this.registered.clear()
    this.graph.clear()
    this.lastVisible = new Set()
    this.structuralDirty = false
    this.rebuildPending = false
    this.forceImmediateRebuild = false
    this.lastRebuildAt = 0
    this.lastCameraKey = ''
  }

  onSmartCullEnabled(): void {
    this.cancelRebuildTimer()
    this.forceImmediateRebuild = true
    this.markStructuralDirty()
  }

  onSmartCullDisabled(): void {
    this.cancelRebuildTimer()
    this.rebuildPending = false
    this.structuralDirty = false
    this.forceImmediateRebuild = false
    this.lastVisible = new Set()
  }

  private markStructuralDirty(): void {
    this.structuralDirty = true
  }

  private cancelRebuildTimer(): void {
    if (this.rebuildTimer !== null) {
      clearTimeout(this.rebuildTimer)
      this.rebuildTimer = null
    }
  }

  private scheduleDeferredRebuild(): void {
    if (this.rebuildTimer !== null) return
    const remaining = Math.max(0, OCCLUSION_REBUILD_INTERVAL_MS - (Date.now() - this.lastRebuildAt))
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null
      this.onDeferredRebuild?.()
    }, remaining)
  }

  private cameraKeyFromParams(params: OcclusionUpdateParams): string {
    return `${Math.floor(params.cameraWorldX / 16) * 16},${Math.floor(params.cameraWorldY / params.sectionHeight) * params.sectionHeight},${Math.floor(params.cameraWorldZ / 16) * 16}`
  }

  update(params: OcclusionUpdateParams): Set<string> {
    this._lastSmartCull = params.smartCull

    if (!params.smartCull) {
      this.onSmartCullDisabled()
      return this.lastVisible
    }

    const cameraKey = this.cameraKeyFromParams(params)
    const cameraMoved = cameraKey !== this.lastCameraKey
    if (cameraMoved) {
      this.lastCameraKey = cameraKey
      this.cancelRebuildTimer()
      this.rebuildPending = false
    }

    const intervalElapsed = Date.now() - this.lastRebuildAt >= OCCLUSION_REBUILD_INTERVAL_MS
    const shouldRebuild = this.forceImmediateRebuild || cameraMoved || (this.structuralDirty && intervalElapsed)

    if (shouldRebuild) {
      this.graph.runFullUpdate(cameraKey, params)
      this.lastVisible = new Set(this.graph.getVisibleKeys())
      this.structuralDirty = false
      this.rebuildPending = false
      this.forceImmediateRebuild = false
      this.lastRebuildAt = Date.now()
      this.cancelRebuildTimer()
    } else if (this.structuralDirty) {
      this.rebuildPending = true
      this.scheduleDeferredRebuild()
    }

    return this.lastVisible
  }

  isRebuildPending(): boolean {
    return this.rebuildPending
  }

  isSectionVisible(key: string): boolean {
    if (!this.registered.has(key)) return !this._lastSmartCull
    return this.lastVisible.has(key)
  }

  hasRegisteredSection(key: string): boolean {
    return this.registered.has(key)
  }

  getVisibleKeys(): ReadonlySet<string> {
    return this.lastVisible
  }

  getStep(key: string): number | undefined {
    return this.graph.getStep(key)
  }

  getVersion(): number {
    return this.graph.getVersion()
  }

  getLastRebuildStats(): Readonly<OcclusionRebuildStats> {
    return this.graph.getLastRebuildStats()
  }

  getGraph(): SectionOcclusionGraph {
    return this.graph
  }

  /** Test seam — whether a structural change is pending a rebuild. */
  isStructuralDirty(): boolean {
    return this.structuralDirty
  }
}

export function hsvToRgb(step: number): number {
  const hue = (step % 50) / 50
  const h = hue * 6
  const c = 0.9
  const x = c * (1 - Math.abs((h % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (h < 1) {
    r = c
    g = x
  } else if (h < 2) {
    r = x
    g = c
  } else if (h < 3) {
    g = c
    b = x
  } else if (h < 4) {
    g = x
    b = c
  } else if (h < 5) {
    r = x
    b = c
  } else {
    r = c
    b = x
  }
  const m = 0.1
  const ri = Math.round((r + m) * 255)
  const gi = Math.round((g + m) * 255)
  const bi = Math.round((b + m) * 255)
  return (ri << 16) | (gi << 8) | bi
}
