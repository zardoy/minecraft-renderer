import * as THREE from 'three'
import { GraphicsBackend, GraphicsBackendLoader } from '../graphicsBackend'
import { useWorkerProxy, deepPrepareForTransfer, findProblemTransfer } from '../lib/workerProxy'
import { initMesherWorker, meshersSendMcData } from '../lib/worldrendererCommon'
import { dynamicMcDataFiles } from '../lib/buildSharedConfig.mjs'
import { addNewStat } from '../lib/ui/newStats'
import { createGraphicsBackendBase, type ThreeJsBackendMethods } from './graphicsBackend'
import { addCanvasForWorker } from './documentRenderer'

export const createGraphicsBackendOffThread: GraphicsBackendLoader = async (initOptions) => {
  const worker = initMesherWorker(() => { })
  const promise = new Promise(resolve => {
    worker.onmessage = ({ data }) => {
      if (data.type === 'sideControlTookOver') {
        resolve(data)
      }
    }
  })
  worker.postMessage({ type: 'sideControl', value: 'graphicsBackendThree' })
  await promise
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
    // startPanorama: proxy.startPanorama,
    async startPanorama() { },
    async startWorld(options) {
      meshersSendMcData([worker], options.version, [...dynamicMcDataFiles, 'items', 'itemsArray', 'entitiesByName', 'blocksByStateId'])

      options.inWorldRenderingConfig['__syncToWorker'] = true

      if (options.playerStateReactive) {
        options.playerStateReactive['__syncToWorker'] = true
      }

      if (options.rendererState) {
        options.rendererState['__syncFromWorker'] = true
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

export const isOffthreadRendererSupported = () => {
  // check if toOffscreenCanvas is supported
  return 'OffscreenCanvas' in window && 'transferControlToOffscreen' in HTMLCanvasElement.prototype && !process.env.SINGLE_FILE_BUILD_MODE
}
