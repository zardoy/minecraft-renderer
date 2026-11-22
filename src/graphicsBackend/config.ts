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
  /** new sections appear with edges first, then fill in (instead of the plain fade) */
  futuristicReveal: false,
  /** new chunks dissolve in over this long, like vanilla's Chunk Fade (0.75 s); 0 = at once */
  chunkFadeMs: 750,

  /** Master toggle for section occlusion graph (smart / cave cull). Disabled in spectator. */
  smartCull: false,

  // Performance settings
  wasmMesher: true,
  /** Render full 1×1 cubes through the instanced shader path (requires WebGL2). */
  shaderCubeBlocks: false,
  /** 0=off, 1=holes red, 2=tileIndex, 3=faceId colors, 4=atlas alpha */
  shaderCubeDebugMode: 0,
  mesherWorkers: 1,
  /**
   * Animated block textures (water, lava, fire, portals...). `basic` switches frames,
   * `smooth` also blends frames of animations that request it (command blocks, magma...) like vanilla.
   */
  animatedTextures: 'smooth' as 'off' | 'basic' | 'smooth',
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
  /**
   * Client light: a dedicated WASM worker computes block and sky light in the browser (Minecraft 1.17+; older versions keep the
   * server's light). Follows the `clientLighting` option, `?clientLight=0|1` in the page URL overrides it.
   */
  enableClientLight: true,
  /**
   * Trust the light a column arrives with (server light) and give it to client light as-is, like the vanilla client: new columns are then
   * not relit (no recompute, no publication waves, no remesh); client light only works on edits. 1.18+ only (older versions send light
   * in update_light packets). On by default for performance. Known gap: the singleplayer generator's light is fake (block light 15
   * everywhere), so singleplayer looks fullbright with this on until the generator computes real light.
   */
  trustColumnLight: true,

  // Rendering engine settings
  /** Face shading: vanilla Minecraft vs higher-contrast client look */
  shadingTheme: 'high-contrast' as 'vanilla' | 'high-contrast',
  /** Synced from player reactive state (dimension / nether) — consumed by mesher */
  cardinalLight: 'default' as string,
  dayCycle: true,
  smoothLighting: true,
  enableLighting: true,
  /** Entity shading is on unless the entity lighting option is turned off. Block lighting stays on enableLighting. */
  enableEntityLighting: true,
  starfield: true,
  defaultSkybox: true,
  clouds: true,
  /** Grass, flowers, crops and leaves sway in the wind (vertex shader only, no remesh to toggle). */
  wavingGrass: true,
  /** Sun shadows on chunk geometry: `soft` uses a wider filter. Off at night and outside the overworld. */
  sunShadows: 'normal' as 'off' | 'normal' | 'soft',
  /** Blocks around the camera that receive sun shadows (16-128). */
  sunShadowsDistance: 64,
  /** Screen-space antialiasing of the world frame (one extra full-screen pass when on). */
  antialiasing: 'off' as 'off' | 'fxaa',
  // Post effects (all cost a few full-screen passes when on, nothing when off)
  /** Glow around light emitting blocks (torches, lava, glowstone...). */
  bloom: false,
  /** Colour look of world blocks, done in the block shaders (no extra pass, safe on phones). */
  colorGrading: 'warm' as 'off' | 'warm' | 'cinematic' | 'vivid',
  /** Light shafts from the sun through gaps in terrain and clouds. */
  godRays: false,
  vignette: false,
  /** Camera motion blur. */
  motionBlur: false,
  /** World Y of the cloud layer (vanilla overworld: 192 since 1.18, 128 before). */
  cloudHeight: 192,
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
  /** Element shown on a panel inside VR sessions (HUD and menus), needs HTML-in-Canvas. Empty = off. */
  // first match in document order: #game-ui wraps #ui-root when the client provides it
  vrUiSelector: '#game-ui, #ui-root' as string,

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
      preventEscapeMenu: false,
      inVrSession: false
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
