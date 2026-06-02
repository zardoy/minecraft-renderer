import * as THREE from 'three'
import { GraphicsBackend, GraphicsBackendLoader } from '../graphicsBackend'
import { useWorkerProxy, deepPrepareForTransfer, findProblemTransfer } from '../lib/workerProxy'
import { installRendererPatchHandler } from '../lib/rendererStateBridge'
import { meshersSendMcDataAwait } from '../lib/worldrendererCommon'
import { dynamicMcDataFiles } from '../lib/buildSharedConfig.mjs'
import { addNewStat, MC_RENDERER_DEBUG_OVERLAY_CLASS } from '../lib/ui/newStats'
import type { MenuBackgroundOptions } from './menuBackground/types'
import { MENU_BACKGROUND_MC_VERSION } from './menuBackground/shared'
import { createGraphicsBackendBase, type ThreeJsBackendMethods } from './graphicsBackendBase'
import { addCanvasForWorker } from './documentRenderer'

function initThreeWorker(onGotMessage: (data: any) => void) {
  // Node environment needs an absolute path, but browser needs the url of the file
  const workerName = 'threeWorker.js'

  let worker: any
  if (process.env.SINGLE_FILE_BUILD) {
    const workerCode = document.getElementById('three-worker-code')!.textContent!
    const blob = new Blob([workerCode], { type: 'text/javascript' })
    worker = new Worker(window.URL.createObjectURL(blob))
  } else {
    worker = new Worker(workerName)
  }

  worker.onmessage = ({ data }) => {
    onGotMessage(data)
  }
  if (worker.on) worker.on('message', (data) => { worker.onmessage({ data }) })
  return worker
}

export const createGraphicsBackendOffThread: GraphicsBackendLoader = async (initOptions) => {
  const worker = initThreeWorker(() => { })
  type WorkerType = ReturnType<ReturnType<typeof createGraphicsBackendBase>['workerProxy']>

  const proxy = useWorkerProxy<WorkerType>(worker)
  const canvas = addCanvasForWorker()
  canvas.onSizeChanged((w, h) => {
    proxy.updateSizeExternal(w, h, window.devicePixelRatio || 1)
  })

  const preparedInitOptions = deepPrepareForTransfer(initOptions, worker)
  try {
    proxy.init(preparedInitOptions, canvas.canvas)
  } catch (err) {
    findProblemTransfer(preparedInitOptions)
    throw err
  }

  const backendMethodsProxy = new Proxy({} as ThreeJsBackendMethods, {
    get(_target, prop) {
      if (typeof prop !== 'string') {
        return undefined
      }
      return async (...args: any[]) => proxy.callBackendMethod(prop as any, ...args)
    }
  })

  const backend: GraphicsBackend = {
    id: 'threejs',
    displayName: `three.js ${THREE.REVISION}`,
    async startMenuBackground(menuBackgroundStartOptions?: MenuBackgroundOptions) {
      const mcData = menuBackgroundStartOptions?.resourcesManager?.currentResources?.mcData
      if (mcData) {
        const workerThreeSendData = {
          ...dynamicMcDataFiles,
          items: 'itemsArray',
          entities: 'entitiesArray',
        }
        await meshersSendMcDataAwait([worker], MENU_BACKGROUND_MC_VERSION, workerThreeSendData, mcData)
      }
      const prepared = deepPrepareForTransfer(menuBackgroundStartOptions ?? {}, worker)
      try {
        await proxy.startMenuBackground(structuredClone(prepared))
      } catch (err) {
        findProblemTransfer(prepared)
        throw err
      }
    },
    async startWorld(options) {
      const workerThreeSendData = {
        ...dynamicMcDataFiles,
        items: 'itemsArray',
        entities: 'entitiesArray',
      }
      await meshersSendMcDataAwait(
        [worker],
        options.version,
        workerThreeSendData,
        options.resourcesManager.currentResources.mcData
      )
      console.log('mc data sent to three worker')

      options.inWorldRenderingConfig['__syncToWorker'] = true

      if (options.playerStateReactive) {
        options.playerStateReactive['__syncToWorker'] = true
        options.playerStateReactive['__syncToWorkerSubscribe'] = false
        options.playerStateReactive['__syncToWorkerInterval'] = 100
      }

      if (options.rendererState) {
        installRendererPatchHandler(worker, options.rendererState)
      }
      if (options.nonReactiveState) {
        options.nonReactiveState['__syncFromWorker'] = true
      }
      options.nonReactiveState['__syncFromWorkerInterval'] = 200
      const prepared = deepPrepareForTransfer(options, worker)
      try {
        await proxy.startWorld(structuredClone(prepared))
        console.log('startWorld done')
      } catch (err) {
        findProblemTransfer(prepared)
        throw err
      }
      proxy.updateSizeExternal(canvas.size.width, canvas.size.height, window.devicePixelRatio || 1)


      const fpsStat = addNewStat('fps')
      setInterval(() => {
        const { fps, avgRenderTime, worstRenderTime } = options.nonReactiveState
        fpsStat.updateText(`FPS: ${fps.toFixed(0)} (${avgRenderTime.toFixed(0)}ms/${worstRenderTime.toFixed(0)}ms)`)
        options.nonReactiveState.fps = 0
      }, 1000)

      const chunksStat = addNewStat('downloaded-chunks', 100, 140, 20, {
        className: MC_RENDERER_DEBUG_OVERLAY_CLASS,
      })
      setInterval(() => {
        const advanced = (initOptions.config.statsVisible ?? 0) > 1
        chunksStat.setVisibility(advanced)
        if (advanced) {
          chunksStat.updateText(options.nonReactiveState.world.chunksFullInfo)
        }
      }, 200)
    },
    disconnect() {
      canvas.destroy()
      proxy.disconnect()
      worker.terminate()
    },
    setRendering(rendering) {
      proxy.setRendering(rendering)
    },
    updateCamera(pos, yaw, pitch) {
      proxy.updateCamera(pos ? { x: pos.x, y: pos.y, z: pos.z } : null, yaw, pitch)
    },
    soundSystem: undefined,
    backendMethods: backendMethodsProxy
  }

  return backend
}
createGraphicsBackendOffThread.id = 'threejs-off-thread'
createGraphicsBackendOffThread.displayName = 'three.js Multi-thread'
createGraphicsBackendOffThread.description = [
  'Edge-cutting technology that uses a dedicated thread for graphics.',
  'Slightly higher power and RAM usage.',
  'More stable FPS (mid-range devices), but possible inputlag if TPS is low.',
  'On low-end devices it might result in device throttling and stuttering.'
].join(' ')

export const isOffthreadRendererSupported = () => {
  // check if toOffscreenCanvas is supported
  return 'OffscreenCanvas' in window && 'transferControlToOffscreen' in HTMLCanvasElement.prototype && !process.env.SINGLE_FILE_BUILD_MODE
}
