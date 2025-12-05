/**
 * AppViewer Example - Shows how to use the AppViewer class
 *
 * This example demonstrates:
 * - Loading a graphics backend
 * - Setting up a world
 * - Managing player state
 * - Handling panorama mode
 */

import { Vec3 } from 'vec3'
import { AppViewer } from '../graphicsBackend/appViewer'
import { ResourcesManager } from '../resourcesManager/resourcesManager'
import { WorldView } from '../worldView'
import { getInitialPlayerState } from '../graphicsBackend/playerState'

// Example world provider implementation
class ExampleWorldProvider {
  private blocks = new Map<string, number>()

  getColumnAt(pos: Vec3) {
    // Return a simple column with some blocks
    return {
      toJson: () => new Uint8Array([1, 2, 3]), // Simple chunk data
      minY: 0,
      worldHeight: 256,
      blockEntities: {}
    }
  }

  setBlockStateId(pos: Vec3, stateId: number) {
    this.blocks.set(`${pos.x},${pos.y},${pos.z}`, stateId)
  }

  getBiome(pos: Vec3) {
    return 1 // Plains biome
  }
}

// Example usage class
export class AppViewerExample {
  private appViewer: AppViewer
  private resourcesManager: ResourcesManager

  constructor() {
    // Create resource manager
    this.resourcesManager = new ResourcesManager()

    // Create app viewer with custom config
    this.appViewer = new AppViewer({
      config: {
        fpsLimit: 60,
        powerPreference: 'high-performance',
        sceneBackground: '#87CEEB', // Sky blue
        statsVisible: 1
      },
      rendererConfig: {
        renderEntities: true,
        smoothLighting: true,
        fov: 75,
        renderDistance: 10
      }
    })

    // Set the resource manager
    this.appViewer.resourcesManager = this.resourcesManager
  }

  /**
   * Initialize and load the graphics backend
   */
  async init() {
    try {
      // Load minecraft data for version 1.16.4
      const version = '1.16.4'
      await this.resourcesManager.loadSourceData(version)
      this.resourcesManager.currentConfig = { version }

      // Load graphics backend (Three.js)
      const { createGraphicsBackend } = await import('../three/graphicsBackend')
      await this.appViewer.loadBackend(createGraphicsBackend)

      console.log('AppViewer initialized successfully')
    } catch (error) {
      console.error('Failed to initialize AppViewer:', error)
      throw error
    }
  }

  /**
   * Start panorama mode (menu background)
   */
  startPanorama() {
    this.appViewer.startPanorama()
    console.log('Panorama started')
  }

  /**
   * Start world rendering
   */
  async startWorld() {
    try {
      // Create a simple world
      const world = new ExampleWorldProvider()

      // Set some blocks
      world.setBlockStateId(new Vec3(0, 64, 0), 1) // Stone
      world.setBlockStateId(new Vec3(1, 64, 0), 2) // Grass
      world.setBlockStateId(new Vec3(0, 64, 1), 3) // Dirt

      // Start the world with render distance 5
      const renderDistance = 5
      const startPosition = new Vec3(0, 65, 0)

      await this.appViewer.startWorld(world, renderDistance, undefined, startPosition)

      // Initialize world view
      if (this.appViewer.worldView) {
        await this.appViewer.worldView.init(startPosition)
      }

      // Set camera position
      this.appViewer.updateCamera(
        new Vec3(0, 66, 5), // Position
        0,                  // Yaw
        -Math.PI / 6        // Pitch (looking down slightly)
      )

      console.log('World started successfully')
    } catch (error) {
      console.error('Failed to start world:', error)
      throw error
    }
  }

  /**
   * Update player state
   */
  updatePlayerState(updates: Partial<any>) {
    Object.assign(this.appViewer.playerState.reactive, updates)
  }

  /**
   * Get current renderer state
   */
  getRendererState() {
    return {
      reactive: this.appViewer.rendererState,
      nonReactive: this.appViewer.nonReactiveState
    }
  }

  /**
   * Wait for world to be ready
   */
  async waitForWorldReady() {
    await this.appViewer.worldReady
    console.log('World is ready')
  }

  /**
   * Cleanup resources
   */
  destroy() {
    this.appViewer.destroyAll()
    console.log('AppViewer destroyed')
  }
}

// Usage example
export async function runExample() {
  const example = new AppViewerExample()

  try {
    // Initialize
    await example.init()

    // Start with panorama
    example.startPanorama()

    // Wait a bit, then switch to world
    setTimeout(async () => {
      await example.startWorld()
      await example.waitForWorldReady()

      // Update player state
      example.updatePlayerState({
        username: 'ExamplePlayer',
        gameMode: 'creative'
      })

      console.log('Example completed successfully')
    }, 2000)

  } catch (error) {
    console.error('Example failed:', error)
    example.destroy()
  }
}

// For browser usage
if (typeof window !== 'undefined') {
  (window as any).AppViewerExample = AppViewerExample
    ; (window as any).runAppViewerExample = runExample
}


