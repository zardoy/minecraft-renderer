/**
 * Graphics Backend Types
 *
 * Core types for the graphics backend system.
 */

import { PlayerStateReactive } from '../playerState/playerState'
import { ResourcesManagerTransferred } from '../resourcesManager'
import { WorldViewWorker } from '../worldView'
import { Vec3 } from 'vec3'
import { WorldRendererConfig } from './config'

// ============================================================================
// Graphics Backend Configuration
// ============================================================================

export type MaybePromise<T> = Promise<T> | T

export interface SoundSystem {
  playSound: (position: { x: number, y: number, z: number }, path: string, volume?: number, pitch?: number, timeout?: number) => void
  destroy: () => void
}

import type { MenuBackgroundOptions } from '../three/menuBackground/types'
import type { RendererStorageOptions } from './rendererDefaultOptions'
import type { MenuBackgroundRenderer } from '../three/menuBackground/renderer'
import type { PerformanceInstabilityFactors } from '../performanceMonitor'

/** Graphics backend configuration */
export interface GraphicsBackendConfig {
  fpsLimit?: number
  statsVisible?: number
  sceneBackground: string
  timeoutRendering?: boolean
  /** Default options when `startMenuBackground()` is called without arguments */
  menuBackground?: MenuBackgroundOptions
}

// ============================================================================
// World Renderer Configuration
// ============================================================================

// ============================================================================
// State Types
// ============================================================================

/** Frame timing event for performance monitoring */
export interface FrameTimingEvent {
  type: 'frameStart' | 'frameEnd' | 'cameraUpdate' | 'frameDisplay'
  timestamp: number
  duration?: number
}

/** Non-reactive state for performance data */
export interface NonReactiveState {
  fps: number
  worstRenderTime: number
  avgRenderTime: number
  world: {
    chunksLoaded: Set<string>
    chunksTotalNumber: number
    allChunksLoaded?: boolean
  }
  renderer: {
    timeline: {
      live: FrameTimingEvent[]
      frozen: FrameTimingEvent[]
      lastSecond: FrameTimingEvent[]
    }
  }
}

/** Renderer reactive state */
export interface RendererReactiveState {
  world: {
    chunksLoaded: Set<string>
    heightmaps: Map<string, Int16Array>
    allChunksLoaded: boolean
    mesherWork: boolean
    /** Low-FPS / render instability factors (see `performanceMonitor`). */
    instabilityFactors: PerformanceInstabilityFactors
    intersectMedia: any | null
  }
  renderer: string
  preventEscapeMenu: boolean
}

// ============================================================================
// Player State Types
// ============================================================================

// ============================================================================
// Graphics Backend Interfaces
// ============================================================================

/** Graphics initialization options */
export interface GraphicsInitOptions<S = any> {
  config: GraphicsBackendConfig
  /** Live app options (e.g. valtio proxy); used for WebGL `gpuPreference` at context creation. */
  getRendererOptions?: () => RendererStorageOptions
  rendererSpecificSettings: S
  callbacks: {
    displayCriticalError: (error: Error) => void
    setRendererSpecificSettings: (key: string, value: any) => void
    fireCustomEvent: (eventName: string, ...args: any[]) => void
  }
}

/** Display world options for starting world rendering */
export interface DisplayWorldOptions {
  version: string
  worldView: WorldViewWorker
  inWorldRenderingConfig: WorldRendererConfig
  playerStateReactive: PlayerStateReactive
  rendererState: RendererReactiveState
  nonReactiveState: NonReactiveState
  resourcesManager: ResourcesManagerTransferred
}

/** Graphics backend interface */
export interface GraphicsBackend {
  id: string
  displayName: string
  startMenuBackground(options?: MenuBackgroundOptions): Promise<void>
  startWorld(options: DisplayWorldOptions): Promise<void>
  disconnect(): void
  setRendering(rendering: boolean): void
  updateCamera(pos: Vec3 | null, yaw: number, pitch: number): void
  soundSystem?: any
  backendMethods?: any
  getDebugOverlay?(): { entitiesString?: string, left?: Record<string, string>, right?: Record<string, string> }
  /** Active main-menu background, when `currentDisplay === 'menu'`. */
  getMenuBackground?(): MenuBackgroundRenderer | undefined
}

/** Graphics backend loader function type */
export type GraphicsBackendLoader = ((options: GraphicsInitOptions) => MaybePromise<GraphicsBackend>) & {
  id: string
  displayName?: string
  description?: string
}

// ============================================================================
// World View Interface
// ============================================================================

/** World view interface for type compatibility */
export interface WorldViewLike {
  isPlayground?: boolean
  addWaitTime?: number
  loadedChunks: Record<string, boolean>
  init(pos: Vec3): Promise<void>
  setBlockStateId(pos: Vec3, stateId: number): void
  unloadAllChunks(): void
  emit(event: string, ...args: any[]): boolean
  on(event: string, callback: (...args: any[]) => void): void
}
