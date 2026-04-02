/**
 * Graphics Backend Base - Shared functionality for Three.js backends.
 *
 * Contains common backend methods and utilities used by both single-thread
 * and off-thread implementations.
 */

import * as THREE from 'three'
import { Vec3 } from 'vec3'
import type { GraphicsBackend, GraphicsInitOptions, DisplayWorldOptions } from '../graphicsBackend'
import { createWorkerProxy, restoreTransferred } from '../lib/workerProxy'
import { ResourcesManager } from '../resourcesManager'
import { FrameTimingCollector } from '../lib/frameTimingCollector'
import { WorldRendererThree } from './worldRendererThree'
import { DocumentRenderer, isWebWorker, ThreeRendererMainData } from './documentRenderer'
import { PanoramaRenderer } from './panorama'
import { WorldViewWorker } from '../worldView'

// Disable Three.js color management for compatibility
THREE.ColorManagement.enabled = false
// Enable Three.js in global scope for debugging
globalThis.THREE = THREE

/**
 * Get backend methods from world renderer instance.
 */
export const getBackendMethods = (worldRenderer: WorldRendererThree): any => {
  return {
    updateMap: worldRenderer.entities.updateMap.bind(worldRenderer.entities),
    updateCustomBlock: worldRenderer.updateCustomBlock.bind(worldRenderer),
    getBlockInfo: worldRenderer.getBlockInfo.bind(worldRenderer),
    playEntityAnimation: worldRenderer.entities.playAnimation.bind(worldRenderer.entities),
    damageEntity: worldRenderer.entities.handleDamageEvent.bind(worldRenderer.entities),
    updatePlayerSkin: worldRenderer.entities.updatePlayerSkin.bind(worldRenderer.entities),
    changeHandSwingingState: worldRenderer.changeHandSwingingState.bind(worldRenderer),
    getHighestBlocks: worldRenderer.getHighestBlocks.bind(worldRenderer),
    reloadWorld: worldRenderer.reloadWorld.bind(worldRenderer),
    updateEntityModel: worldRenderer.entities.updateEntityModel.bind(worldRenderer.entities),
    playEntityModelAnimation: worldRenderer.entities.playEntityModelAnimation.bind(worldRenderer.entities),
    addMedia: worldRenderer.media.addMedia.bind(worldRenderer.media),
    destroyMedia: worldRenderer.media.destroyMedia.bind(worldRenderer.media),
    setControlMode: worldRenderer.media.setControlMode.bind(worldRenderer.media),
    setVideoPlaying: worldRenderer.media.setVideoPlaying.bind(worldRenderer.media),
    setVideoSeeking: worldRenderer.media.setVideoSeeking.bind(worldRenderer.media),
    setVideoVolume: worldRenderer.media.setVideoVolume.bind(worldRenderer.media),
    setVideoSpeed: worldRenderer.media.setVideoSpeed.bind(worldRenderer.media),
    handleUserClick: worldRenderer.media.handleUserClick.bind(worldRenderer.media),
    addSectionAnimation(id: string, animation: typeof worldRenderer.sectionsOffsetsAnimations[string]) {
      worldRenderer.sectionsOffsetsAnimations[id] = animation
    },
    removeSectionAnimation(id: string) {
      delete worldRenderer.sectionsOffsetsAnimations[id]
    },
    shakeFromDamage: worldRenderer.cameraShake.shakeFromDamage.bind(worldRenderer.cameraShake),
    onPageInteraction: worldRenderer.media.onPageInteraction.bind(worldRenderer.media),
    downloadMesherLog: worldRenderer.downloadMesherLog.bind(worldRenderer),
    // Fireworks methods
    explodeFirework: worldRenderer.fireworksLegacy.explode.bind(worldRenderer.fireworksLegacy),
    explodeFireworkFacingCamera: worldRenderer.fireworksLegacy.explodeFacingCamera.bind(worldRenderer.fireworksLegacy),
    addWaypoint: worldRenderer.waypoints.addWaypoint.bind(worldRenderer.waypoints),
    removeWaypoint: worldRenderer.waypoints.removeWaypoint.bind(worldRenderer.waypoints),
    // Cinematic script methods
    startCinimaticScript: worldRenderer.cinimaticScript.startScript.bind(worldRenderer.cinimaticScript),
    stopCinimaticScript: worldRenderer.cinimaticScript.stopScript.bind(worldRenderer.cinimaticScript),
    launchFirework: worldRenderer.fireworks.launchFirework.bind(worldRenderer.fireworks),
    // New method for updating skybox
    setSkyboxImage: worldRenderer.skyboxRenderer.setSkyboxImage.bind(worldRenderer.skyboxRenderer),
    // Rain methods
    setRain: (newState: boolean) => worldRenderer.toggleModule('rain', newState),
    spawnBlockBreakParticles(x: number, y: number, z: number, blockName: string, floorMap: number[], biomeName?: string) {
      const module = worldRenderer.getModule<import('./modules/blockBreakParticles').BlockBreakParticlesModule>('blockBreakParticles')
      module?.spawnBlockBreakParticles(x, y, z, blockName, floorMap, biomeName)
    },
    spawnBlockCrackParticle(x: number, y: number, z: number, face: number, blockName: string, floorMap: number[], biomeName?: string) {
      const module = worldRenderer.getModule<import('./modules/blockBreakParticles').BlockBreakParticlesModule>('blockBreakParticles')
      module?.spawnCrackParticle(x, y, z, face, blockName, floorMap, biomeName)
    },
    async loadGeometryExport(exportData: any) {
      // Import dynamically to avoid circular dependencies
      const { applyWorldGeometryExport } = await import('./worldGeometryExport')
      return applyWorldGeometryExport(worldRenderer, exportData)
    }
  }
}

export type ThreeJsBackendMethods = ReturnType<typeof getBackendMethods>

/**
 * Restorers for transferring objects to workers.
 */
const initOptionsRestorers = [
  // WorldDataEmitterWorker
]

/**
 * Call mods method helper.
 */
export const callModsMethod = (method: string, ...args: any[]) => {
  for (const mod of Object.values((globalThis.loadedMods ?? {}) as Record<string, any>)) {
    try {
      mod.threeJsBackendModule?.[method]?.(...args)
    } catch (err) {
      const errorMessage = `[mod three.js] Error calling ${method} on ${mod.name}: ${err}`
      throw new Error(errorMessage)
    }
  }
}

/**
 * Creates the base graphics backend with core functionality.
 */
export const createGraphicsBackendBase = () => {
  // Private state
  let initOptions!: GraphicsInitOptions
  let documentRenderer: DocumentRenderer | null = null
  let panoramaRenderer: PanoramaRenderer | null = null
  let worldRenderer: WorldRendererThree | null = null
  let frameTimingCollector: FrameTimingCollector | null = null

  const init = (initOptionsArg: GraphicsInitOptions, mainData?: ThreeRendererMainData) => {
    if (isWebWorker) {
      initOptions = restoreTransferred(initOptionsArg, initOptionsRestorers, globalThis as unknown as Worker)
    } else {
      initOptions = initOptionsArg
    }

    documentRenderer = new DocumentRenderer(initOptions, mainData?.canvas)
      ; (globalThis as any).renderer = documentRenderer.renderer
      ; (globalThis as any).documentRenderer = documentRenderer
      ; (globalThis as any).threeJsBackend = backend

    callModsMethod('default', backend)
  }

  const startPanorama = async () => {
    if (!documentRenderer) throw new Error('Document renderer not initialized')
    if (worldRenderer) return

    if (!panoramaRenderer) {
      // Create panorama-specific init options with resourcesManager
      const panoramaInitOptions = { ...initOptions }
      panoramaRenderer = new PanoramaRenderer(documentRenderer, panoramaInitOptions, !!process.env.SINGLE_FILE_BUILD_MODE)
        ; (globalThis as any).panoramaRenderer = panoramaRenderer

      callModsMethod('panoramaCreated', panoramaRenderer)
      await panoramaRenderer.start()
      callModsMethod('panoramaReady', panoramaRenderer)
    }
  }

  const startWorld = async (displayOptionsArg: DisplayWorldOptions) => {
    const displayOptionsRestorers = [ResourcesManager, WorldViewWorker]
    const displayOptions: DisplayWorldOptions = isWebWorker ? restoreTransferred(displayOptionsArg, displayOptionsRestorers, globalThis as unknown as Worker) : displayOptionsArg

    if (!documentRenderer) throw new Error('Document renderer not initialized')

    documentRenderer.nonReactiveState = displayOptions.nonReactiveState
      // Set resourcesManager globally for world rendering
      ; (globalThis as any).resourcesManager = displayOptions.resourcesManager

    if (panoramaRenderer) {
      panoramaRenderer.dispose()
      panoramaRenderer = null
    }

    worldRenderer = new WorldRendererThree(documentRenderer.renderer, initOptions, displayOptions)

    await worldRenderer.worldReadyPromise

    frameTimingCollector = new FrameTimingCollector(displayOptions.nonReactiveState)
      ; (globalThis as any).frameTimingCollector = frameTimingCollector

    const originalRender = documentRenderer.render

    documentRenderer.render = function (sizeChanged: boolean) {
      originalRender.call(this, sizeChanged)
      frameTimingCollector?.markFrameStart()

      if (!displayOptions.inWorldRenderingConfig.paused) {
        worldRenderer?.render(sizeChanged)
      }

      frameTimingCollector?.markFrameEnd()
      frameTimingCollector?.markFrameDisplay()
    }

    documentRenderer.inWorldRenderingConfig = displayOptions.inWorldRenderingConfig

      ; (globalThis as any).world = worldRenderer

    callModsMethod('worldReady', worldRenderer)
  }

  const disconnect = () => {
    if (panoramaRenderer) {
      panoramaRenderer.dispose()
      panoramaRenderer = null
    }

    if (documentRenderer) {
      documentRenderer.dispose()
    }

    if (worldRenderer) {
      worldRenderer.destroy()
      worldRenderer = null
    }
  }

  // Public interface
  const backend: GraphicsBackend = {
    id: 'threejs',
    displayName: `three.js ${THREE.REVISION}`,
    startPanorama,
    startWorld,
    disconnect,
    setRendering(rendering) {
      documentRenderer!.setPaused(!rendering)
      if (worldRenderer) worldRenderer.renderingActive = rendering
    },
    getDebugOverlay: () => ({
      get entitiesString() {
        return worldRenderer?.entities.getDebugString()
      },
      get left() {
        return {
          'Geo Memory': worldRenderer?.worldBlockGeometry.getEstimatedMemoryUsage().readable ?? '-'
        }
      },
    }),
    updateCamera(pos: Vec3 | null, yaw: number, pitch: number) {
      // Mark camera update event for frame timing visualization
      frameTimingCollector?.markCameraUpdate(!pos)
      worldRenderer?.setFirstPersonCamera(pos, yaw, pitch)
    },
    get soundSystem() {
      return worldRenderer?.soundSystem
    },
    get backendMethods() {
      if (!worldRenderer) return undefined
      return getBackendMethods(worldRenderer)
    }
  }

  return {
    main: {
      init,
      backend
    },
    workerProxy() {
      return createWorkerProxy({
        init(initOptionsArg: GraphicsInitOptions, canvas: OffscreenCanvas) {
          init(initOptionsArg, { canvas })
        },
        updateSizeExternal(width: number, height: number, pixelRatio: number) {
          documentRenderer?.updateSizeExternal(width, height, pixelRatio)
        },
        startPanorama,
        startWorld,
        disconnect,
        setRendering: backend.setRendering,
        updateCamera(pos, yaw, pitch) {
          const posVec = pos ? new Vec3(pos.x, pos.y, pos.z) : null
          frameTimingCollector?.markCameraUpdate(!posVec)
          backend.updateCamera(posVec, yaw, pitch)
        },
        async callBackendMethod<K extends keyof ThreeJsBackendMethods>(
          method: K,
          ...args: Parameters<ThreeJsBackendMethods[K]>
        ): Promise<ReturnType<ThreeJsBackendMethods[K]> extends Promise<infer R> ? R : ReturnType<ThreeJsBackendMethods[K]>> {
          if (!worldRenderer) {
            throw new Error('World renderer not initialized')
          }

          const methods = getBackendMethods(worldRenderer)
          const target = methods[method]

          if (!target) {
            throw new Error(`Backend method ${String(method)} is unavailable`)
          }

          return target(...args)
        }
      })
    }
  }
}
