/**
 * Initial Menu Start Example - Similar to your original implementation
 *
 * This demonstrates how to recreate the functionality from your original appViewer code.
 */

import { Vec3 } from 'vec3'
import { AppViewer } from '../graphicsBackend/appViewer'
import { ResourcesManager } from '../resourcesManager/resourcesManager'
import { WorldView } from '../worldView'
import { getInitialPlayerState } from '../graphicsBackend/playerState'

// Global app viewer instance (similar to your original)
export const appViewer = new AppViewer({
  config: {
    fpsLimit: undefined,
    powerPreference: 'high-performance', // You can change this based on options
    sceneBackground: 'lightblue',
    timeoutRendering: false
  }
})

// Set up resource manager
appViewer.resourcesManager = new ResourcesManager()

// Make it globally available (similar to your original)
if (typeof window !== 'undefined') {
  ; (window as any).appViewer = appViewer
}

/**
 * Load Minecraft data for a specific version
 */
async function loadMinecraftData(version: string) {
  if (!appViewer.resourcesManager) {
    throw new Error('Resource manager not initialized')
  }

  await appViewer.resourcesManager.loadSourceData(version)
  appViewer.resourcesManager.currentConfig = { version }
  await appViewer.resourcesManager.updateAssetsData?.({})
}

/**
 * Get sync world (placeholder - you'll need to implement this based on your needs)
 */
function getSyncWorld(version: string) {
  // This is a placeholder - you'll need to implement this based on your world provider
  return {
    setBlockStateId: (pos: Vec3, stateId: number) => {
      console.log(`Setting block at ${pos.x},${pos.y},${pos.z} to state ${stateId}`)
    },
    getColumnAt: (pos: Vec3) => ({
      toJson: () => new Uint8Array([1, 2, 3]),
      minY: 0,
      worldHeight: 256,
      blockEntities: {}
    })
  }
}

/**
 * Initial menu start function - similar to your original
 */
export const initialMenuStart = async () => {
  try {
    if (appViewer.currentDisplay === 'world') {
      appViewer.resetBackend(true)
    }

    // Check for demo mode
    const demo = new URLSearchParams(window.location.search).get('demo')
    if (!demo) {
      appViewer.startPanorama()
      return
    }

    // Demo mode - create a simple world
    const version = '1.16.4' // You can change this

    // Load minecraft data
    await loadMinecraftData(version)

    // Get world
    const world = getSyncWorld(version)

    // Set some example blocks (you'll need to get proper state IDs)
    const waterStateId = 1 // Placeholder - get from mcData.blocksByName.water.defaultState
    world.setBlockStateId(new Vec3(0, 64, 0), waterStateId)
    world.setBlockStateId(new Vec3(1, 64, 0), waterStateId)
    world.setBlockStateId(new Vec3(1, 64, 1), waterStateId)
    world.setBlockStateId(new Vec3(0, 64, 1), waterStateId)
    world.setBlockStateId(new Vec3(-1, 64, -1), waterStateId)
    world.setBlockStateId(new Vec3(-1, 64, 0), waterStateId)
    world.setBlockStateId(new Vec3(0, 64, -1), waterStateId)

    // Set initial player state
    appViewer.playerState.reactive = getInitialPlayerState()

    // Start world
    await appViewer.startWorld(world, 3)

    // Update camera to look down at the water
    appViewer.backend?.updateCamera(
      new Vec3(0, 65.7, 0), // Position
      0,                    // Yaw
      -Math.PI / 2          // Pitch (looking down)
    )

    // Initialize world view
    if (appViewer.worldView) {
      await appViewer.worldView.init(new Vec3(0, 64, 0))
    }

    console.log('Demo world started successfully')
  } catch (error) {
    console.error('Failed to start demo:', error)
  }
}

/**
 * Initialize the graphics backend
 */
export async function initializeGraphicsBackend() {
  try {
    // Load the Three.js backend
    const { createGraphicsBackend } = await import('../three/graphicsBackend')
    await appViewer.loadBackend(createGraphicsBackend)
    console.log('Graphics backend loaded successfully')
  } catch (error) {
    console.error('Failed to load graphics backend:', error)
    throw error
  }
}

/**
 * Complete initialization function
 */
export async function initialize() {
  await initializeGraphicsBackend()
  await initialMenuStart()
}

// Make functions globally available for browser usage
if (typeof window !== 'undefined') {
  ; (window as any).initialMenuStart = initialMenuStart
    ; (window as any).initializeGraphicsBackend = initializeGraphicsBackend
    ; (window as any).initialize = initialize
}

// Auto-initialize if in browser and not in a module context
if (typeof window !== 'undefined' && !window.location.search.includes('manual')) {
  // Auto-initialize after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      void initialize()
    })
  } else {
    void initialize()
  }
}


