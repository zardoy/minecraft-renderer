/**
 * AppViewer - Base application viewer for Minecraft renderer.
 *
 * This is the main entry point for integrating the renderer into an application.
 * It manages:
 * - Graphics backend loading and lifecycle
 * - World view management
 * - Player state
 * - Renderer state
 */

import { Vec3 } from 'vec3'
import { proxy } from 'valtio'
import type {
  GraphicsBackend,
  GraphicsBackendConfig,
  GraphicsBackendLoader,
  GraphicsInitOptions,
  DisplayWorldOptions,
  RendererReactiveState,
  NonReactiveState
} from './types'
import { WorldView, WorldProvider, WorldViewWorker } from '../worldView'
import { getInitialPlayerState } from './playerState'
import { defaultWorldRendererConfig, defaultGraphicsBackendConfig, getDefaultRendererState, WorldRendererConfig } from './config'
import { PlayerStateReactive } from '../playerState/playerState'
import { ResourcesManager, ResourcesManagerTransferred } from '../resourcesManager'
import { preloadMesherWorkerScript } from './preloadWorkers'
import type { MenuBackgroundOptions } from '../three/menuBackground/types'
import type { RendererStorageOptions } from './rendererDefaultOptions'

export interface AppViewerOptions {
  config?: Partial<GraphicsBackendConfig>
  rendererConfig?: Partial<WorldRendererConfig>
  menuBackground?: MenuBackgroundOptions
}

/**
 * AppViewer - Main application viewer class.
 *
 * This is designed to be extended for specific use cases (game client, playground, etc.)
 */
export class AppViewer {
  waitBackendLoadPromises: Promise<void>[] = []

  onWorldStart?: () => void
  onBeforeWorldStart?: () => void

  // World view
  worldView?: WorldView

  // Configuration
  readonly config: GraphicsBackendConfig
  readonly menuBackgroundOptions: MenuBackgroundOptions
  readonly inWorldRenderingConfig: WorldRendererConfig

  // Backend
  backend?: GraphicsBackend
  backendLoader?: GraphicsBackendLoader
  private currentState?: {
    method: string
    args: any[]
  }

  // Display state
  currentDisplay: 'menu' | 'world' | null = null

  // Player state
  playerState = {
    reactive: getInitialPlayerState()
  }

  // Renderer state
  rendererState: RendererReactiveState
  nonReactiveState: NonReactiveState

  // World ready promise
  worldReady!: Promise<void>
  private resolveWorldReady!: () => void

  // Timing
  lastCamUpdate = 0

  /** Bound by `subscribeRendererOptions` / `bindRendererOptions` — source of truth for renderer-owned settings. */
  private getRendererOptions?: () => RendererStorageOptions

  constructor(options: AppViewerOptions = {}, public resourcesManager: ResourcesManager = new ResourcesManager()) {
    this.config = {
      ...defaultGraphicsBackendConfig,
      ...options.config
    }
    this.menuBackgroundOptions = {
      ...options.config?.menuBackground,
      ...options.menuBackground
    }
    this.inWorldRenderingConfig = proxy({
      ...defaultWorldRendererConfig,
      ...options.rendererConfig
    })

    const defaultState = getDefaultRendererState()
    this.rendererState = defaultState.reactive
    this.nonReactiveState = defaultState.nonReactive

    this.initWorldReadyPromise()
  }

  private initWorldReadyPromise(): void {
    const { promise, resolve } = Promise.withResolvers<void>()
    this.worldReady = promise
    this.resolveWorldReady = resolve
  }

  /**
   * Preload mesher worker script (HTTP validate + ephemeral Worker + `mc-web-ping` / `mc-web-pong`).
   * Chooses `/mesherWasm.js` vs `/mesher.js` from `inWorldRenderingConfig.wasmMesher`.
   */
  preloadWorkers (): Promise<void> {
    const script = this.inWorldRenderingConfig.wasmMesher ? 'mesherWasm.js' : 'mesher.js'
    return preloadMesherWorkerScript({ script })
  }

  /** Wire app options storage (valtio proxy) for backend init (WebGL gpuPreference, etc.). */
  bindRendererOptions(getOptions: () => RendererStorageOptions): void {
    this.getRendererOptions = getOptions
  }

  /**
   * Load a graphics backend.
   */
  async loadBackend(loader: GraphicsBackendLoader): Promise<void> {
    if (this.backend) {
      this.disconnectBackend()
    }

    await Promise.all(this.waitBackendLoadPromises)
    this.waitBackendLoadPromises = []

    this.backendLoader = loader

    const loaderOptions: GraphicsInitOptions = {
      config: this.config,
      getRendererOptions: this.getRendererOptions,
      callbacks: {
        displayCriticalError: (error) => {
          console.error('[AppViewer] Critical error:', error)
        },
        setRendererSpecificSettings: (key, value) => {
          // Override in implementation
        },
        fireCustomEvent: (eventName, ...args) => {
          // Override in implementation
        }
      },
      rendererSpecificSettings: {}
    }

    const backendResult = loader(loaderOptions)
    this.backend = await Promise.resolve(backendResult)

    // Execute queued action if exists
    if (this.currentState) {
      if (this.currentState.method === 'startMenuBackground') {
        this.startMenuBackground(...this.currentState.args)
      } else {
        const { method, args } = this.currentState
          ; (this.backend as any)[method](...args)
      }
    }
  }

  /**
   * Start the world with a given world provider and render distance.
   */
  async startWorld(
    world: WorldProvider,
    renderDistance: number,
    playerStateReactive: PlayerStateReactive = this.playerState.reactive,
    startPosition?: Vec3
  ): Promise<boolean> {
    if (this.currentDisplay === 'world') {
      throw new Error('World already started')
    }

    this.currentDisplay = 'world'
    const finalStartPosition = startPosition ?? new Vec3(0, 64, 0)

    this.worldView = new WorldView(world, renderDistance, finalStartPosition)
    this.worldView.isPlayground = this.inWorldRenderingConfig.isPlayground

    // this.inWorldRenderingConfig.futuristicReveal = true
    const displayWorldOptions: DisplayWorldOptions = {
      version: this.resourcesManager?.currentConfig?.version ?? '1.20.4',
      worldView: this.worldView as unknown as WorldViewWorker,
      inWorldRenderingConfig: this.inWorldRenderingConfig,
      playerStateReactive,
      rendererState: this.rendererState,
      nonReactiveState: this.nonReactiveState,
      resourcesManager: this.resourcesManager! as unknown as ResourcesManagerTransferred
    }

    this.onBeforeWorldStart?.()
    let promise: Promise<void> | undefined
    if (this.backend) {
      const result = this.backend.startWorld(displayWorldOptions)
      if (result && typeof result.then === 'function') {
        promise = result
      }
    }

    this.currentState = { method: 'startWorld', args: [displayWorldOptions] }

    await promise
    this.resolveWorldReady()
    this.onWorldStart?.()
    return !!promise
  }

  /**
   * Start the main-menu background (3D scene behind UI).
   */
  startMenuBackground(menuBackgroundOptions?: MenuBackgroundOptions): void {
    if (this.currentDisplay === 'menu') return

    const merged: MenuBackgroundOptions = {
      ...this.menuBackgroundOptions,
      ...menuBackgroundOptions,
      resourcesManager: menuBackgroundOptions?.resourcesManager ?? this.resourcesManager
    }

    if (this.backend) {
      this.currentDisplay = 'menu'
      this.backend.startMenuBackground(merged)
    }

    this.currentState = { method: 'startMenuBackground', args: [merged] }
  }

  /**
   * Reset the backend.
   */
  resetBackend(cleanState = false): void {
    this.disconnectBackend(cleanState)
    if (this.backendLoader) {
      void this.loadBackend(this.backendLoader)
    }
  }

  /**
   * Disconnect the backend.
   */
  disconnectBackend(cleanState = false): void {
    if (cleanState) {
      this.currentState = undefined
      this.currentDisplay = null
      this.worldView = undefined
    }

    if (this.backend) {
      this.backend.disconnect()
      this.backend = undefined
    }

    this.currentDisplay = null
    this.initWorldReadyPromise()
    this.rendererState = proxy(getDefaultRendererState().reactive)
    this.nonReactiveState = getDefaultRendererState().nonReactive
  }

  /**
   * Update camera position and rotation.
   */
  updateCamera(pos: Vec3 | null, yaw: number, pitch: number): void {
    this.backend?.updateCamera(pos, yaw, pitch)
  }

  /**
   * Set rendering active/paused.
   */
  setRendering(rendering: boolean): void {
    this.backend?.setRendering(rendering)
  }

  /**
   * Start world with bot (convenience method).
   */
  async startWithBot(bot: any, renderDistance: number): Promise<void> {
    await this.startWorld(bot.world, renderDistance)
    if (this.worldView) {
      // Listen to bot events if worldView supports it
      if (typeof (this.worldView as any).listenToBot === 'function') {
        (this.worldView as any).listenToBot(bot)
      }
    }
  }

  /**
   * Destroy all resources including resource manager.
   */
  destroyAll(): void {
    this.disconnectBackend(true)
    if (this.resourcesManager && typeof (this.resourcesManager as any).destroy === 'function') {
      (this.resourcesManager as any).destroy()
    }
  }

  /**
   * Get utility methods.
   */
  get utils() {
    const backend = this.backend
    return {
      async waitingForChunks(): Promise<void> {
        if ((backend as any)?.worldState?.allChunksLoaded) return

        return new Promise<void>((resolve) => {
          const interval = setInterval(() => {
            if ((backend as any)?.worldState?.allChunksLoaded) {
              clearInterval(interval)
              resolve()
            }
          }, 100)
        })
      }
    }
  }

  /**
   * Destroy the viewer and cleanup resources.
   */
  destroy(): void {
    this.disconnectBackend(true)
  }
}
