import * as THREE from 'three'
import { GraphicsBackend, GraphicsBackendLoader } from '../graphicsBackend'
import { useWorkerProxy, deepPrepareForTransfer, findProblemTransfer } from '../lib/workerProxy'
import { meshersSendMcData } from '../lib/worldrendererCommon'
import { dynamicMcDataFiles } from '../lib/buildSharedConfig.mjs'
import { addNewStat } from '../lib/ui/newStats'
import { createGraphicsBackendBase, type ThreeJsBackendMethods } from './graphicsBackend'
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
    // startPanorama: proxy.startPanorama,
    async startPanorama() { },
    async startWorld(options) {
      const workerThreeSendData = {
        ...dynamicMcDataFiles,
        items: 'itemsArray',
        entities: 'entitiesArray',
      }
      meshersSendMcData([worker], options.version, workerThreeSendData, initOptions.resourcesManager.currentResources.mcData)
      console.log('mc data sent to three worker')

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
