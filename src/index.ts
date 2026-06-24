/**
 * Minecraft Renderer
 *
 * A modular Minecraft world renderer with Three.js WebGL backend.
 *
 * ## Quick Start
 *
 * ```typescript
 * import { AppViewer, createGraphicsBackend } from 'minecraft-renderer'
 * import { WorldView } from 'minecraft-renderer'
 *
 * // Create viewer
 * const viewer = new AppViewer()
 *
 * // Load backend
 * await viewer.loadBackend(createGraphicsBackend)
 *
 * // Start world
 * await viewer.startWorld(world, renderDistance)
 * ```
 *
 * ## Architecture
 *
 * The renderer is split into several modules:
 *
 * - **Core**: Types, configuration, player state, world view
 * - **Three.js Backend**: WebGL rendering using Three.js
 * - **Playground**: Testing and development environment
 */

// ============================================================================
// Graphics Backend (Core)
// ============================================================================
export * from './graphicsBackend'

// ============================================================================
// World View
// ============================================================================
export { WorldView, WorldViewWorker, chunkPos, sectionPos, delayedIterator } from './worldView'
export type { WorldProvider } from './worldView'

// ============================================================================
// Player State
// ============================================================================
export { getInitialPlayerState, getPlayerStateUtils, getInitialPlayerStateRenderer } from './playerState/playerState'

// ============================================================================
// Resource Manager
// ============================================================================
export { ResourcesManager, LoadedResourcesTransferrable } from './resourcesManager'

// ============================================================================
// Three.js Backend (re-exported for convenience)
// ============================================================================
export { createGraphicsBackendSingleThread } from './three/graphicsBackendSingleThread'
export { createGraphicsBackendOffThread } from './three/graphicsBackendOffThread'

export { DocumentRenderer, addCanvasForWorker, isWebWorker } from './three/documentRenderer'
export { MC_RENDERER_DEBUG_OVERLAY_CLASS } from './lib/ui/newStats'

// Main-menu background (title screen backdrop)
export type {
  MenuBackgroundMode,
  MenuBackgroundOptions,
  MenuBackgroundView,
  V2SceneId,
  V2CameraId,
  V2MenuBackgroundOptions,
  MinecraftBlockGroupId
} from './three/menuBackground'
export {
  MenuBackgroundRenderer,
  ClassicMenuBackground,
  V2MenuBackground,
  WorldBlocksMenuBackground,
  MENU_BACKGROUND_MC_VERSION,
  V2_SCENE_IDS,
  V2_CAMERA_IDS,
  V2_SCENE_LABELS,
  V2_CAMERA_LABELS,
  MINECRAFT_BLOCK_GROUPS,
  MINECRAFT_BLOCK_GROUP_IDS,
  MINECRAFT_BLOCK_GROUP_LABELS,
  RENDERER_DEFAULT_OPTIONS,
  RENDERER_OPTIONS_META,
  RENDERER_RENDER_GUI_SECTIONS,
  MENU_BACKGROUND_OPTION_DEFAULTS,
  MENU_BACKGROUND_MOTION_DEFAULTS,
  menuBackgroundSpeedToMultiplier
} from './three/menuBackground'
export type { RendererDefaultOptionKey, RendererOptionMeta } from './three/menuBackground'
