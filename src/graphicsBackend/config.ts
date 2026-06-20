/**
 * Default configurations for the graphics backend and world renderer.
 */

import { proxy } from 'valtio'
import { defaultPerformanceInstabilityFactors } from '../performanceMonitor'
import type { GraphicsBackendConfig, RendererReactiveState, NonReactiveState } from './types'

/**
 * Default world renderer configuration.
 * These settings control rendering behavior and visual options.
 */
export const defaultWorldRendererConfig = {
  paused: false,

  // Debug settings
  showChunkBorders: false,
  enableDebugOverlay: false,
  debugWasmPerf: false,
  debugModelVariant: undefined as undefined | number[],
  futuristicReveal: false,

  // Performance settings
  wasmMesher: true,
  /** Render full 1×1 cubes through the instanced shader path (requires WebGL2). */
  shaderCubeBlocks: false,
  /** 0=off, 1=holes red, 2=tileIndex, 3=faceId colors, 4=atlas alpha */
  shaderCubeDebugMode: 0,
  mesherWorkers: 1,
  addChunksBatchWaitTime: 200,
  _experimentalSmoothChunkLoading: true,
  _renderByChunks: false,
  autoLowerRenderDistance: false,
  /** Disable WASM mesher worker-side conversion cache (memory hotfix for
   * iOS Safari and other low-RAM environments). Trades performance for
   * lower per-worker RAM. */
  disableMesherConversionCache: false,
  /** Whether to dedicate the last worker exclusively to block-update
   * remeshing (change worker). When true, initial chunk meshing is
   * distributed only across workers[0 .. n-2]. */
  dedicatedChangeWorker: false,

  // Rendering engine settings
  /** Face shading: vanilla Minecraft vs higher-contrast client look */
  shadingTheme: 'high-contrast' as 'vanilla' | 'high-contrast',
  /** Synced from player reactive state (dimension / nether) — consumed by mesher */
  cardinalLight: 'default' as string,
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
  handRenderer: 'vanilla' as 'vanilla' | 'legacy',
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
  instantCameraUpdate: false,
  isRaining: false,
  // rainColor: 'rgb(64, 87, 148)', // original minecraft blue
  rainColor: 'rgb(118, 148, 226)',
  /** Rain particle opacity 0–1. */
  rainOpacity: 0.5,

  // Module states: 'enabled' = force on, 'disabled' = force off, 'auto' = use autoEnableCheck
  moduleStates: {} as Record<string, 'enabled' | 'disabled' | 'auto'>
}

export type WorldRendererConfig = typeof defaultWorldRendererConfig

/**
 * Default graphics backend configuration.
 */
export const defaultGraphicsBackendConfig: GraphicsBackendConfig = {
  fpsLimit: undefined,
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
        chunksLoaded: {},
        heightmaps: {},
        allChunksLoaded: false,
        mesherWork: false,
        instabilityFactors: defaultPerformanceInstabilityFactors(),
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
        chunksLoadedCount: 0,
        chunksTotalNumber: 0,
        chunksFullInfo: '-'
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
