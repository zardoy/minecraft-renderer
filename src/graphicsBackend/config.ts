/**
 * Default configurations for the graphics backend and world renderer.
 */

import { proxy } from 'valtio'
import type {
  GraphicsBackendConfig,
  RendererReactiveState,
  NonReactiveState
} from './types'

/**
 * Default world renderer configuration.
 * These settings control rendering behavior and visual options.
 */
export const defaultWorldRendererConfig = {
  paused: false,

  // Debug settings
  showChunkBorders: false,
  enableDebugOverlay: false,
  debugModelVariant: undefined,
  futuristicReveal: false,

  // Performance settings
  wasmMesher: false,
  mesherWorkers: 1,
  addChunksBatchWaitTime: 200,
  _experimentalSmoothChunkLoading: true,
  _renderByChunks: false,

  // Rendering engine settings
  dayCycle: true,
  smoothLighting: true,
  enableLighting: true,
  starfield: true,
  defaultSkybox: true,
  renderEntities: true,
  extraBlockRenderers: true,
  foreground: true,
  fov: 75,
  volume: 1,

  // Camera visual related settings
  showHand: false,
  viewBobbing: false,
  renderEars: true,
  highlightBlockColor: 'blue' as 'blue' | 'classic' | 'auto' | undefined,

  // Player models
  fetchPlayerSkins: true,
  skinTexturesProxy: undefined as undefined | string,

  // VR settings
  vrSupport: true,
  vrPageGameRendering: true,

  // World settings
  clipWorldBelowY: undefined as undefined | number,
  isPlayground: false,
  instantCameraUpdate: false
}

export type WorldRendererConfig = typeof defaultWorldRendererConfig

/**
 * Default graphics backend configuration.
 */
export const defaultGraphicsBackendConfig: GraphicsBackendConfig = {
  fpsLimit: undefined,
  powerPreference: undefined,
  sceneBackground: 'lightblue',
  timeoutRendering: false
}

/**
 * Creates a new proxied world renderer config with default values.
 */
export const createWorldRendererConfig = (overrides: Partial<WorldRendererConfig> = {}): WorldRendererConfig => {
  return proxy({
    ...defaultWorldRendererConfig,
    ...overrides
  })
}

/**
 * Get default renderer reactive state.
 */
export const getDefaultRendererState = (): {
  reactive: RendererReactiveState
  nonReactive: NonReactiveState
} => {
  return {
    reactive: proxy({
      world: {
        chunksLoaded: new Set<string>(),
        heightmaps: new Map<string, Int16Array>(),
        allChunksLoaded: false,
        mesherWork: false,
        intersectMedia: null
      },
      renderer: '...',
      preventEscapeMenu: false
    }),
    nonReactive: {
      fps: 0,
      worstRenderTime: 0,
      avgRenderTime: 0,
      world: {
        chunksLoaded: new Set(),
        chunksTotalNumber: 0
      },
      renderer: {
        timeline: {
          live: [],
          frozen: [],
          lastSecond: []
        }
      }
    }
  }
}
