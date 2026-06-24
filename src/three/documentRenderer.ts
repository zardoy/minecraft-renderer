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
import * as tween from '@tweenjs/tween.js'
import type { GraphicsBackendConfig, GraphicsInitOptions } from '../graphicsBackend/types'
import { gpuPreferenceToWebGLPowerPreference } from '../three/menuBackground/gpuPreference'
import { WorldRendererConfig } from '../graphicsBackend'

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

class TopRightStats {
  private readonly stats: Stats
  private readonly stats2: Stats
  private readonly statsGl: StatsGl
  private total = 0
  private readonly denseMode: boolean

  constructor(
    private readonly canvas: HTMLCanvasElement,
    initialStatsVisible = 0
  ) {
    this.stats = new Stats()
    this.stats2 = new Stats()
    this.statsGl = new StatsGl({ minimal: true })
    this.stats2.showPanel(2)
    this.denseMode = (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') || (typeof window !== 'undefined' && window.innerHeight < 500)

    this.initStats()
    this.setVisibility(initialStatsVisible)
  }

  private addStat(dom: HTMLElement, size = 80) {
    dom.style.position = 'absolute'
    if (this.denseMode) dom.style.height = '12px'
    dom.style.overflow = 'hidden'
    dom.style.left = ''
    dom.style.top = '0'
    dom.style.right = `${this.total}px`
    dom.style.width = '80px'
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

  private initStats() {
    const hasRamPanel = this.stats2.dom.children.length === 3

    this.addStat(this.stats.dom)
    if (hasRamPanel) {
      this.addStat(this.stats2.dom)
    }

    this.statsGl.init(this.canvas)
    this.statsGl.container.style.display = 'flex'
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
    const visible = level > 0
    if (visible) {
      this.stats.dom.style.display = 'block'
      this.stats2.dom.style.display = level >= 2 ? 'block' : 'none'
      this.statsGl.container.style.display = level >= 2 ? 'block' : 'none'
    } else {
      this.stats.dom.style.display = 'none'
      this.stats2.dom.style.display = 'none'
      this.statsGl.container.style.display = 'none'
    }
  }

  markStart() {
    this.stats.begin()
    this.stats2.begin()
    this.statsGl.begin()
  }

  markEnd() {
    this.stats.end()
    this.stats2.end()
    this.statsGl.end()
  }

  dispose() {
    this.stats.dom.remove()
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
      const gpuPreference = initOptions.getRendererOptions?.()?.gpuPreference ?? 'default'
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas as HTMLCanvasElement,
        preserveDrawingBuffer: true,
        logarithmicDepthBuffer: true,
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

  updatePixelRatio(): void {
    if (typeof window === 'undefined') return

    let pixelRatio = window.devicePixelRatio || 1
    if (!this.renderer.capabilities.isWebGL2) {
      pixelRatio = 1 // WebGL1 has issues with high pixel ratio
    }
    this.renderer.setPixelRatio(pixelRatio)
  }

  sizeUpdated(): void {
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
    this.renderer.setPixelRatio(pixelRatio)
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

      let sizeChanged = false

      // Only update canvas size if a resize event occurred
      if (this.pendingResize) {
        this.updateCanvasSize()
        this.pendingResize = false
      }

      if (this.previousCanvasWidth !== this.currentWidth || this.previousCanvasHeight !== this.currentHeight) {
        this.previousCanvasWidth = this.currentWidth
        this.previousCanvasHeight = this.currentHeight
        this.sizeUpdated()
        sizeChanged = true
      }

      this.frameRender(sizeChanged)

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
    if (this.canvas instanceof HTMLCanvasElement) {
      this.canvas.remove()
    }
    clearInterval(this.fpsInterval)
    this.stats?.dispose()
    this.renderer.dispose()
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
