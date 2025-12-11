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
export {
  WorldView,
  WorldViewWorker,
  chunkPos,
  sectionPos,
  delayedIterator
} from './worldView'
export type { WorldProvider } from './worldView'

// ============================================================================
// Player State
// ============================================================================
export {
  getInitialPlayerState,
  getPlayerStateUtils,
  getInitialPlayerStateRenderer
} from './playerState/playerState'

// ============================================================================
// Resource Manager
// ============================================================================
export {
  ResourcesManager,
  LoadedResourcesTransferrable
} from './resourcesManager'

// ============================================================================
// Three.js Backend (re-exported for convenience)
// ============================================================================
export {
  createGraphicsBackendSingleThread
} from './three/graphicsBackendSingleThread'
export {
  createGraphicsBackendOffThread
} from './three/graphicsBackendOffThread'

export {
  DocumentRenderer,
  addCanvasForWorker,
  isWebWorker
} from './three/documentRenderer'
