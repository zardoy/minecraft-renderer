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
import { defaultWorldRendererConfig, defaultGraphicsBackendConfig, getDefaultRendererState } from './config'
import type { WorldRendererConfig } from '../lib/worldrendererCommon'
import { PlayerStateReactive } from '../playerState/playerState'
import { ResourcesManager, ResourcesManagerTransferred } from '../resourcesManager'

export interface AppViewerOptions {
  config?: Partial<GraphicsBackendConfig>
  rendererConfig?: Partial<WorldRendererConfig>
}

/**
 * AppViewer - Main application viewer class.
 *
 * This is designed to be extended for specific use cases (game client, playground, etc.)
 */
export class AppViewer {
  waitBackendLoadPromises: Promise<void>[] = []

  // World view
  worldView?: WorldView

  // Configuration
  readonly config: GraphicsBackendConfig
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

  constructor(options: AppViewerOptions = {}, public resourcesManager: ResourcesManager = new ResourcesManager()) {
    this.config = {
      ...defaultGraphicsBackendConfig,
      ...options.config
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
   * Load a graphics backend.
   */
  async loadBackend(loader: GraphicsBackendLoader): Promise<void> {
    if (this.backend) {
      this.disconnectBackend()
    }

    await Promise.all(this.waitBackendLoadPromises)
    this.waitBackendLoadPromises = []

    this.backendLoader = loader

    const loaderOptions: GraphicsInitOptions = { // todo!
      resourcesManager: this.resourcesManager! as unknown as ResourcesManagerTransferred,
      config: this.config,
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
      if (this.currentState.method === 'startPanorama') {
        this.startPanorama()
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

    const displayWorldOptions: DisplayWorldOptions = {
      version: this.resourcesManager?.currentConfig?.version ?? '1.20.4',
      worldView: this.worldView as unknown as WorldViewWorker,
      inWorldRenderingConfig: this.inWorldRenderingConfig,
      playerStateReactive,
      rendererState: this.rendererState,
      nonReactiveState: this.nonReactiveState
    }

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
    return !!promise
  }

  /**
   * Start panorama display (menu background).
   */
  startPanorama(): void {
    if (this.currentDisplay === 'menu') return

    if (this.backend) {
      this.currentDisplay = 'menu'
      this.backend.startPanorama()
    }

    this.currentState = { method: 'startPanorama', args: [] }
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
