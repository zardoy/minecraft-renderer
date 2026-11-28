/**
 * DocumentRenderer - Manages Three.js WebGLRenderer and render loop.
 *
 * Features:
 * - Automatic canvas sizing with resize event optimization
 * - FPS limiting support
 * - Stats overlay (optional)
 * - Timeout-based rendering option for background tabs
 */

import * as THREE from 'three'
import Stats from 'stats.js'
import StatsGl from 'stats-gl'
import { FrameTimeline } from '../lib/ui/frameTimeline'
import * as tween from '@tweenjs/tween.js'
import type { GraphicsBackendConfig, GraphicsInitOptions } from '../graphicsBackend/types'
import { gpuPreferenceToWebGLPowerPreference } from '../three/menuBackground/gpuPreference'
import { WorldRendererConfig } from '../graphicsBackend'
import { releaseWebGLRenderer } from '../lib/webglLifecycle'
import { AdaptiveResolution } from './adaptiveResolution'

// ============================================================================
// Types (co-located with implementation)
// ============================================================================

export type { GraphicsBackendConfig }

export interface FrameTimingEvent {
  type: 'frameStart' | 'frameEnd' | 'cameraUpdate' | 'frameDisplay'
  timestamp: number
  duration?: number
}

export interface NonReactiveState {
  fps: number
  worstRenderTime: number
  avgRenderTime: number
  world: {
    chunksLoadedCount: number
    chunksTotalNumber: number
  }
  renderer: {
    timeline: {
      live: FrameTimingEvent[]
      frozen: FrameTimingEvent[]
      lastSecond: FrameTimingEvent[]
    }
  }
}

// GraphicsInitOptions is now imported from ../graphicsBackend/types

export interface ThreeRendererMainData {
  canvas: OffscreenCanvas
}

export const isWebWorker = typeof (globalThis as any).WorkerGlobalScope !== 'undefined' && globalThis instanceof (globalThis as any).WorkerGlobalScope

// ============================================================================
// TopRightStats - Performance stats display
// ============================================================================

/** Below this viewport width (phones in portrait) the stats strip is shorter: the top corner is shared with the game's own buttons. */
const NARROW_VIEWPORT_PX = 520
const timelineSize = (denseMode: boolean) => {
  if (typeof window !== 'undefined' && window.innerWidth < NARROW_VIEWPORT_PX) return { width: 96, height: 24 }
  return { width: 128, height: denseMode ? 24 : 30 }
}

class TopRightStats {
  private readonly timeline: FrameTimeline
  private readonly onResize = () => {
    const { width, height } = timelineSize(this.denseMode)
    this.timeline.resize(width, height)
    // the memory panel sits left of the strip
    this.stats2.dom.style.right = `${width}px`
  }
  private readonly stats2: Stats
  private readonly statsGl: StatsGl
  private total = 0
  private level = 0
  private readonly denseMode: boolean

  constructor(
    private readonly canvas: HTMLCanvasElement,
    initialStatsVisible = 0
  ) {
    this.stats2 = new Stats()
    this.statsGl = new StatsGl({ minimal: true })
    this.stats2.showPanel(2)
    this.denseMode = (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') || (typeof window !== 'undefined' && window.innerHeight < 500)

    const size = timelineSize(this.denseMode)
    this.timeline = new FrameTimeline(size.width, size.height)
    this.initStats(size.width)
    this.setVisibility(initialStatsVisible)
    window.addEventListener('resize', this.onResize)
  }

  private addStat(dom: HTMLElement, size = 80, keepSize = false) {
    dom.style.position = 'absolute'
    if (this.denseMode && !keepSize) dom.style.height = '12px'
    dom.style.overflow = 'hidden'
    // Stats overlays must never eat clicks meant for the game/UI underneath.
    dom.style.pointerEvents = 'none'
    dom.style.left = ''
    dom.style.top = '0'
    dom.style.right = `${this.total}px`
    if (!keepSize) dom.style.width = `${size}px`
    dom.style.zIndex = '1'
    dom.style.opacity = '0.8'
    const hasAppContainer = document.getElementById('corner-indicator-stats')
    const container = hasAppContainer ?? document.body
    if (hasAppContainer) {
      dom.style.position = 'relative'
    }
    container.appendChild(dom)
    this.total += size
  }

  private initStats(timelineWidth: number) {
    const hasRamPanel = this.stats2.dom.children.length === 3

    this.addStat(this.timeline.dom, timelineWidth, true)
    if (hasRamPanel) {
      this.addStat(this.stats2.dom)
    }

    this.statsGl.init(this.canvas)
    this.statsGl.container.style.display = 'flex'
    this.statsGl.container.style.pointerEvents = 'none'
    this.statsGl.container.style.justifyContent = 'flex-end'

    let i = 0
    for (const _child of this.statsGl.container.children) {
      const child = _child as HTMLElement
      if (i++ === 0) {
        child.style.display = 'none'
      }
      child.style.position = ''
    }
  }

  setVisibility(level: number) {
    this.level = level
    const visible = level > 0
    if (visible) {
      this.timeline.setVisible(true)
      this.stats2.dom.style.display = level >= 2 ? 'block' : 'none'
      this.statsGl.container.style.display = level >= 2 ? 'block' : 'none'
    } else {
      this.timeline.setVisible(false)
      this.stats2.dom.style.display = 'none'
      this.statsGl.container.style.display = 'none'
    }
  }

  markStart() {
    this.timeline.begin()
    // the other two panels only show in the advanced level: skip their per-frame work otherwise
    if (this.level < 2) return
    this.stats2.begin()
    this.statsGl.begin()
  }

  markEnd() {
    this.timeline.end()
    if (this.level < 2) return
    this.stats2.end()
    this.statsGl.end()
    // stats-gl adds two performance marks and a measure every frame and never clears them:
    // the browser keeps all of them (~650k entries per hour of play, tens of MB, it was a big part of long-session memory growth)
    performance.clearMarks('cpu-started')
    performance.clearMarks('cpu-finished')
    performance.clearMeasures('cpu-duration')
  }

  dispose() {
    window.removeEventListener('resize', this.onResize)
    this.timeline.dom.remove()
    this.stats2.dom.remove()
    this.statsGl.container.remove()
  }
}

// ============================================================================
// DocumentRenderer - Core rendering loop manager
// ============================================================================

export class DocumentRenderer {
  canvas!: HTMLCanvasElement | OffscreenCanvas
  readonly renderer: THREE.WebGLRenderer
  private animationFrameId?: number
  readonly timeoutId?: number
  private lastRenderTime = 0

  // Size tracking - optimized to only update on resize
  private previousCanvasWidth = 0
  private previousCanvasHeight = 0
  private currentWidth = 0
  private currentHeight = 0
  private pendingResize = false

  private renderedFps = 0
  private fpsInterval: any
  private readonly adaptiveResolution = new AdaptiveResolution()
  private externalDevicePixelRatio: number | undefined
  private pixelRatioDirty = false
  /** pixel ratio to apply in the next `sizeUpdated` (see `updatePixelRatio`) */
  private pendingPixelRatio: number | undefined
  private lastFrameStart = 0
  private readonly stats: TopRightStats | undefined
  private paused = false
  disconnected = false

  // Render hooks
  preRender = () => {}
  render = (sizeChanged: boolean) => {}
  postRender = () => {}
  sizeChanged = () => {}

  droppedFpsPercentage = 0
  config: GraphicsBackendConfig
  onRender: Array<(sizeChanged: boolean) => void> = []
  inWorldRenderingConfig: WorldRendererConfig | undefined
  public nonReactiveState: NonReactiveState | undefined

  constructor(
    public initOptions: GraphicsInitOptions,
    public externalCanvas?: OffscreenCanvas,
    mainData?: ThreeRendererMainData
  ) {
    this.config = initOptions.config

    // Handle canvas creation/transfer based on context
    if (externalCanvas) {
      this.canvas = externalCanvas
    } else {
      this.addToPage()
    }

    try {
      const rendererOptions = initOptions.getRendererOptions?.()
      const gpuPreference = rendererOptions?.gpuPreference ?? 'default'
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas as HTMLCanvasElement,
        // only screenshots read the canvas back; without it the browser may discard the frame after compositing (cheaper on tiled mobile GPUs)
        preserveDrawingBuffer: rendererOptions?.preserveDrawingBuffer ?? true,
        // Plain depth. A logarithmic depth buffer writes gl_FragDepth in every fragment, which turns off early depth rejection and the hidden-surface
        // removal of tiled mobile GPUs: on a Mali-G57 it cost about 2/3 of the frame rate (7 -> 19 FPS at spawn). Near 0.1 / far 1000 with
        // 24-bit depth is precise enough for the view distances used (about 2 cm at 200 blocks).
        logarithmicDepthBuffer: false,
        powerPreference: gpuPreferenceToWebGLPowerPreference(gpuPreference)
      })
    } catch (err: any) {
      initOptions.callbacks.displayCriticalError(new Error(`Failed to create WebGL context, not possible to render (restart browser): ${err.message}`))
      throw err
    }

    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace

    if (!externalCanvas) {
      this.updatePixelRatio()
      // Setup resize listener - only update size on actual resize events
      this.setupResizeListener()
    }

    this.sizeUpdated()
    // Initialize previous dimensions
    this.previousCanvasWidth = this.canvas.width
    this.previousCanvasHeight = this.canvas.height

    const supportsWebGL2 = 'WebGL2RenderingContext' in globalThis
    // Only initialize stats and DOM-related features in main thread (not worker)
    if (!externalCanvas && supportsWebGL2 && !isWebWorker) {
      this.stats = new TopRightStats(this.canvas as HTMLCanvasElement, this.config.statsVisible)
    }

    this.setupFpsTracking()
    this.startRenderLoop()
  }

  /**
   * Setup resize event listener for optimized size updates.
   * Only reads document.body dimensions when resize event fires.
   */
  private setupResizeListener(): void {
    if (typeof window === 'undefined') return

    let resizeTimeout: ReturnType<typeof setTimeout> | undefined

    const handleResize = () => {
      // Debounce resize to avoid excessive updates
      if (resizeTimeout) {
        clearTimeout(resizeTimeout)
      }
      resizeTimeout = setTimeout(() => {
        this.pendingResize = true
      }, 16) // ~60fps debounce
    }

    window.addEventListener('resize', handleResize, { passive: true })
  }

  /** pixel ratio at full resolution: the device ratio after the `maxPixelRatio` cap */
  basePixelRatio(): number {
    // WebGL1 has issues with high pixel ratio
    if (!this.renderer.capabilities.isWebGL2) return 1
    let pixelRatio = this.externalDevicePixelRatio ?? (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)
    const cap = this.config.maxPixelRatio
    if (cap && cap > 0) pixelRatio = Math.min(pixelRatio, cap)
    return pixelRatio
  }

  /** current canvas pixel ratio / the full one: below 1 while adaptive resolution has lowered it */
  get resolutionScale(): number {
    return this.adaptiveResolution.scale
  }

  updatePixelRatio(): void {
    if (typeof window === 'undefined' && this.externalDevicePixelRatio === undefined) return
    if (!this.config.adaptiveResolution && this.adaptiveResolution.scale !== 1) this.adaptiveResolution.reset()
    const pixelRatio = Math.round(this.basePixelRatio() * this.adaptiveResolution.scale * 100) / 100
    if (pixelRatio === (this.pendingPixelRatio ?? this.renderer.getPixelRatio())) return
    // Applied by the next frame right before it renders. Setting it here resized the canvas at once, which clears it: called after a frame
    // was drawn (adaptive resolution, the 1 s timer), the browser showed that cleared canvas, a frame of page background (gray flash).
    this.pendingPixelRatio = pixelRatio
    // the render targets that follow the canvas size (post processing, shadows of the screen) get the sizeChanged frame
    this.pixelRatioDirty = true
  }

  sizeUpdated(): void {
    if (this.pendingPixelRatio !== undefined) {
      // setPixelRatio resizes the canvas too; setSize below then keeps it
      if (this.pendingPixelRatio !== this.renderer.getPixelRatio()) this.renderer.setPixelRatio(this.pendingPixelRatio)
      this.pendingPixelRatio = undefined
    }
    this.renderer.setSize(this.currentWidth, this.currentHeight, false)
  }

  private addToPage(): void {
    this.canvas = addCanvasToPage()
    // Initial size read
    this.updateCanvasSize()
  }

  /**
   * Update size from external source (for worker/offscreen scenarios).
   */
  updateSizeExternal(newWidth: number, newHeight: number, pixelRatio: number): void {
    this.currentWidth = newWidth
    this.currentHeight = newHeight
    this.externalDevicePixelRatio = pixelRatio
    this.updatePixelRatio()
    this.sizeUpdated()
  }

  /**
   * Update canvas size from document body.
   * Only called when pendingResize is true (after resize event).
   */
  private updateCanvasSize(): void {
    if (this.externalCanvas) return
    if (typeof document === 'undefined') return

    // Only read body dimensions when we know a resize occurred
    const innerWidth = document.body.offsetWidth
    const innerHeight = document.body.offsetHeight

    if (this.currentWidth !== innerWidth) {
      this.currentWidth = innerWidth
    }
    if (this.currentHeight !== innerHeight) {
      this.currentHeight = innerHeight
    }
  }

  private setupFpsTracking(): void {
    let max = 0
    this.fpsInterval = setInterval(() => {
      if (max > 0) {
        this.droppedFpsPercentage = this.renderedFps / max
      }
      max = Math.max(this.renderedFps, max)
      if (this.nonReactiveState) {
        this.nonReactiveState.fps = this.renderedFps
      }
      this.renderedFps = 0
      // follows the resolution option and devicePixelRatio changes (browser zoom, another monitor)
      this.updatePixelRatio()
    }, 1000)
  }

  private startRenderLoop(): void {
    const animate = () => {
      if (this.disconnected) return

      // Schedule next frame based on rendering mode
      if (this.config.timeoutRendering) {
        const targetFps = this.config.fpsLimit ? Math.min(this.config.fpsLimit, 60) : 60
        const timeoutMs = 1000 / targetFps
        ;(this as any).timeoutId = setTimeout(animate, timeoutMs)
      } else {
        this.animationFrameId = requestAnimationFrame(animate)
      }

      if (this.paused || (this.renderer.xr.isPresenting && !this.inWorldRenderingConfig?.vrPageGameRendering)) {
        this.lastFrameStart = 0
        return
      }

      // Handle FPS limiting (for requestAnimationFrame mode)
      if (!this.config.timeoutRendering && this.config.fpsLimit) {
        const now = performance.now()
        const elapsed = now - this.lastRenderTime
        const fpsInterval = 1000 / this.config.fpsLimit

        if (elapsed < fpsInterval) {
          return
        }

        this.lastRenderTime = now - (elapsed % fpsInterval)
      }

      const frameStart = performance.now()
      const frameInterval = this.lastFrameStart ? frameStart - this.lastFrameStart : 0
      this.lastFrameStart = frameStart

      let sizeChanged = false

      // Only update canvas size if a resize event occurred
      if (this.pendingResize) {
        this.updateCanvasSize()
        this.pendingResize = false
      }

      if (this.pixelRatioDirty || this.previousCanvasWidth !== this.currentWidth || this.previousCanvasHeight !== this.currentHeight) {
        this.previousCanvasWidth = this.currentWidth
        this.previousCanvasHeight = this.currentHeight
        this.pixelRatioDirty = false
        this.sizeUpdated()
        sizeChanged = true
      }

      this.frameRender(sizeChanged)

      // a frame limit or timer rendering paces the frames on purpose, and a hidden page gets throttled frames: that is not GPU load
      const pageHidden = typeof document !== 'undefined' && document.hidden
      if (this.config.adaptiveResolution && frameInterval > 0 && !this.config.fpsLimit && !this.config.timeoutRendering && !pageHidden) {
        if (this.adaptiveResolution.onFrame(frameStart, frameInterval, performance.now() - frameStart, this.basePixelRatio())) {
          this.updatePixelRatio()
        }
      }

      // Update stats visibility each frame (main thread only)
      if (this.config.statsVisible !== undefined) {
        this.stats?.setVisibility(this.config.statsVisible)
      }
    }

    animate()
  }

  frameRender(sizeChanged: boolean): void {
    this.preRender()
    this.stats?.markStart()
    tween.update()

    if (!(globalThis as any).freezeRender) {
      this.render(sizeChanged)
    }

    for (const fn of this.onRender) {
      fn(sizeChanged)
    }

    this.renderedFps++
    this.stats?.markEnd()
    this.postRender()
  }

  setPaused(paused: boolean): void {
    this.paused = paused
  }

  dispose(): void {
    this.disconnected = true

    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId)
    }
    if (this.timeoutId) {
      clearTimeout(this.timeoutId)
    }
    clearInterval(this.fpsInterval)
    this.stats?.dispose()
    releaseWebGLRenderer(this.renderer)
  }
}

// ============================================================================
// Helper functions
// ============================================================================

/**
 * Adds a canvas element to the page.
 */
function addCanvasToPage(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.id = 'viewer-canvas'
  document.body.appendChild(canvas)
  return canvas
}

/**
 * Creates a canvas for worker thread rendering.
 */
export const addCanvasForWorker = (): {
  canvas: OffscreenCanvas
  destroy: () => void
  onSizeChanged: (cb: (width: number, height: number) => void) => void
  size: { width: number; height: number }
} => {
  const canvas = addCanvasToPage()
  const transferred = canvas.transferControlToOffscreen()
  let removed = false
  let onSizeChanged = (w: number, h: number) => {}
  let oldSize = { width: 0, height: 0 }

  const checkSize = () => {
    if (removed) return
    if (oldSize.width !== window.innerWidth || oldSize.height !== window.innerHeight) {
      onSizeChanged(window.innerWidth, window.innerHeight)
      oldSize = { width: window.innerWidth, height: window.innerHeight }
    }
    requestAnimationFrame(checkSize)
  }
  requestAnimationFrame(checkSize)

  return {
    canvas: transferred,
    destroy() {
      removed = true
      canvas.remove()
    },
    onSizeChanged(cb: (width: number, height: number) => void) {
      onSizeChanged = cb
    },
    get size() {
      return { width: window.innerWidth, height: window.innerHeight }
    }
  }
}
