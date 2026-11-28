import * as THREE from 'three'
import { GraphicsBackend, GraphicsBackendLoader } from '../graphicsBackend'
import { useWorkerProxy, deepPrepareForTransfer, findProblemTransfer } from '../lib/workerProxy'
import { meshersSendMcDataAwait } from '../lib/worldrendererCommon'
import { dynamicMcDataFiles } from '../lib/buildSharedConfig.mjs'
import { addNewStat, MC_RENDERER_DEBUG_OVERLAY_CLASS } from '../lib/ui/newStats'
import type { MenuBackgroundOptions } from './menuBackground/types'
import { MENU_BACKGROUND_MC_VERSION } from './menuBackground/shared'
import { createGraphicsBackendBase, type ThreeJsBackendMethods } from './graphicsBackendBase'
import { addCanvasForWorker, timelineSize, WORKER_FRAME_TIMES } from './documentRenderer'
import { FrameTimeline } from '../lib/ui/frameTimeline'
import type { WorldView } from '../worldView'

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
  if (worker.on)
    worker.on('message', data => {
      worker.onmessage({ data })
    })
  return worker
}

export const createGraphicsBackendOffThread: GraphicsBackendLoader = async initOptions => {
  const workerSideChannel = {
    onMessage: (_data: unknown) => {}
  }
  let frameTimeline: FrameTimeline | undefined
  let stopFrameTimeline = () => {}
  const worker = initThreeWorker(data => {
    if (data?.type === WORKER_FRAME_TIMES) {
      frameTimeline?.addFrames(data.frames)
      return
    }
    workerSideChannel.onMessage(data)
  })
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
          entities: 'entitiesArray'
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
      const worldView = options.worldView as unknown as WorldView
      workerSideChannel.onMessage = (data: any) => {
        if (data?.type === 'reloadLoadedChunks') {
          void worldView.reloadLoadedChunks().catch(err => {
            console.error('[Renderer] Failed to reload chunks after mesher reconfigure:', err)
          })
        }
      }

      const workerThreeSendData = {
        ...dynamicMcDataFiles,
        items: 'itemsArray',
        entities: 'entitiesArray'
      }
      await meshersSendMcDataAwait([worker], options.version, workerThreeSendData, options.resourcesManager.currentResources.mcData)
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

      // the same FPS bar as the main-thread renderer, fed with the frames the render worker measures; a thin outline marks it as off-thread
      stopFrameTimeline()
      const denseMode = process.env.NODE_ENV === 'production' || window.innerHeight < 500
      const { width, height } = timelineSize(denseMode)
      frameTimeline = new FrameTimeline(width, height)
      const statsContainer = document.getElementById('corner-indicator-stats')
      Object.assign(frameTimeline.dom.style, {
        position: statsContainer ? 'relative' : 'absolute',
        top: '0',
        right: '0',
        zIndex: '1',
        opacity: '0.8',
        outline: '1px solid rgba(96, 165, 250, 0.9)',
        outlineOffset: '-1px'
      })
      frameTimeline.dom.title = 'Frames of the off-thread renderer (render worker)'
      ;(statsContainer ?? document.body).appendChild(frameTimeline.dom)
      const onResize = () => {
        const size = timelineSize(denseMode)
        frameTimeline?.resize(size.width, size.height)
      }
      window.addEventListener('resize', onResize)
      const visibilityTimer = setInterval(() => {
        frameTimeline?.setVisible((initOptions.config.statsVisible ?? 0) > 0)
        options.nonReactiveState.fps = 0
      }, 200)
      stopFrameTimeline = () => {
        clearInterval(visibilityTimer)
        window.removeEventListener('resize', onResize)
        frameTimeline?.dom.remove()
        frameTimeline = undefined
      }

      const chunksStat = addNewStat('downloaded-chunks', 100, 140, 20, {
        className: MC_RENDERER_DEBUG_OVERLAY_CLASS
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
      stopFrameTimeline()
      canvas.destroy()
      proxy.disconnect()
      worker.terminate()
    },
    setRendering(rendering) {
      proxy.setRendering(rendering)
    },
    updateCamera(pos, yaw, pitch, options) {
      proxy.updateCamera(pos ? { x: pos.x, y: pos.y, z: pos.z } : null, yaw, pitch, options)
    },
    soundSystem: undefined,
    backendMethods: backendMethodsProxy
  }

  return backend
}
createGraphicsBackendOffThread.id = 'threejs-off-thread'
createGraphicsBackendOffThread.displayName = 'three.js Multi-thread EXPERIMENTAL'
createGraphicsBackendOffThread.description = [
  '(UNSTABLE, DO NOT USE ON ANDROID).',
  'Edge-cutting technology that uses a dedicated thread for graphics.',
  'Slightly higher power and RAM usage.',
  'More stable FPS (mid-range devices), but possible inputlag if TPS is low.',
  'On low-end devices it might result in device throttling and stuttering.'
].join(' ')

export const isOffthreadRendererSupported = () => {
  // check if toOffscreenCanvas is supported
  return 'OffscreenCanvas' in window && 'transferControlToOffscreen' in HTMLCanvasElement.prototype && !process.env.SINGLE_FILE_BUILD_MODE
}
