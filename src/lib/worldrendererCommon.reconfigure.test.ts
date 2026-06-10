import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Vec3 } from 'vec3'
import { proxy } from 'valtio'
import * as worldRendererModule from './worldrendererCommon'
import { WorldRendererCommon } from './worldrendererCommon'
import { defaultWorldRendererConfig } from '../graphicsBackend/config'
import { getInitialPlayerState } from '../playerState/playerState'
import type { DisplayWorldOptions, GraphicsInitOptions } from '../graphicsBackend/types'

vi.mock('./ui/newStats', () => ({
  addNewStat: vi.fn(() => ({ updateText: vi.fn(), setVisibility: vi.fn() })),
  updateStatText: vi.fn(),
  removeAllStats: vi.fn(),
  updatePanesVisibility: vi.fn(),
  MC_RENDERER_DEBUG_OVERLAY_CLASS: 'mc-renderer-debug-overlay',
}))

vi.mock('./utils/skins', () => ({
  setSkinsConfig: vi.fn(),
  steveTexture: {},
  stevePngUrl: '',
}))

function ensurePromiseWithResolvers() {
  if (!Promise.withResolvers) {
    Promise.withResolvers = function <T>() {
      let resolve!: (value: T | PromiseLike<T>) => void
      let reject!: (reason?: unknown) => void
      const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
      })
      return { promise, resolve, reject }
    }
  }
}

class TestWorldRenderer extends WorldRendererCommon {
  outputFormat = 'threeJs' as const
  rerenderCalls = 0

  changeBackgroundColor() {}
  changeCardinalLight() {}
  handleWorkerMessage() {}
  updateCamera() {}
  render() {}
  updateShowChunksBorder() {}

  protected override afterMesherWorkersReconfigured() {
    this.rerenderCalls++
  }
}

function createRenderer(workerCount = 2) {
  const rendererState = proxy({
    world: {
      chunksLoaded: {} as Record<string, true>,
      heightmaps: {} as Record<string, Int16Array>,
      allChunksLoaded: false,
      mesherWork: false,
      instabilityFactors: {},
      intersectMedia: null,
    },
    renderer: '',
    preventEscapeMenu: false,
  })

  const displayOptions: DisplayWorldOptions = {
    version: '1.21.1',
    worldView: new EventEmitter() as DisplayWorldOptions['worldView'],
    inWorldRenderingConfig: { ...defaultWorldRendererConfig, mesherWorkers: workerCount },
    playerStateReactive: getInitialPlayerState(),
    rendererState,
    nonReactiveState: {
      fps: 0,
      worstRenderTime: 0,
      avgRenderTime: 0,
      world: {
        chunksLoadedCount: 0,
        chunksTotalNumber: 0,
        chunksFullInfo: '',
      },
      renderer: {
        timeline: { live: [], frozen: [], lastSecond: [] },
      },
    },
    resourcesManager: {
      currentResources: {
        mcData: { version: {} },
        blocksAtlasJson: {},
        blockstatesModels: {},
      },
    } as DisplayWorldOptions['resourcesManager'],
  }

  const initOptions: GraphicsInitOptions = {
    config: { sceneBackground: '#000' },
    rendererSpecificSettings: {},
    callbacks: {
      displayCriticalError: vi.fn(),
      setRendererSpecificSettings: vi.fn(),
      fireCustomEvent: vi.fn(),
    },
  }

  const renderer = new TestWorldRenderer(displayOptions.resourcesManager, displayOptions, initOptions)
  renderer.active = true
  renderer.workers = Array.from({ length: workerCount }, () => ({
    postMessage: vi.fn(),
    terminate: vi.fn(),
  }))
  renderer['syncMesherPoolSnapshot']()
  renderer.viewDistance = 8
  renderer.viewerChunkPosition = new Vec3(0, 64, 0)
  renderer.worldSizeParams = { minY: 0, worldHeight: 256 }
  return renderer
}

describe('WorldRendererCommon.reconfigureMesherWorkers', () => {
  beforeEach(() => {
    ensurePromiseWithResolvers()
    vi.stubGlobal('location', { href: 'http://localhost/' })
    vi.stubGlobal('Worker', class MockWorker {
      postMessage = vi.fn()
      terminate = vi.fn()
      addEventListener = vi.fn()
      onmessage: ((event: MessageEvent) => void) | null = null
    })
    vi.spyOn(worldRendererModule, 'meshersSendMcData').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  test('recreates workers with new count and triggers remesh', async () => {
    const renderer = createRenderer(3)
    const terminated = renderer.workers.map((worker) => worker.terminate)
    renderer.worldRendererConfig.mesherWorkers = 1

    await renderer.reconfigureMesherWorkers()

    for (const terminate of terminated) {
      expect(terminate).toHaveBeenCalled()
    }
    expect(renderer.workers).toHaveLength(1)
    expect(renderer.rerenderCalls).toBe(1)
  })

  test('recreates workers when mesher pipeline changes', async () => {
    const renderer = createRenderer(2)
    const terminated = renderer.workers.map((worker) => worker.terminate)
    renderer.worldRendererConfig.wasmMesher = false

    await renderer.reconfigureMesherWorkers()

    for (const terminate of terminated) {
      expect(terminate).toHaveBeenCalled()
    }
    expect(renderer.workers).toHaveLength(2)
    expect(renderer.rerenderCalls).toBe(1)
  })
})
