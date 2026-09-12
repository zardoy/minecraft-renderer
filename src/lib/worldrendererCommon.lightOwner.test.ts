import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Vec3 } from 'vec3'
import { proxy } from 'valtio'
import * as worldRendererModule from './worldrendererCommon'
import { WorldRendererCommon } from './worldrendererCommon'
import { defaultWorldRendererConfig } from '../graphicsBackend/config'
import { defaultPerformanceInstabilityFactors } from '../performanceMonitor'
import { getInitialPlayerState } from '../playerState/playerState'
import type { DisplayWorldOptions, GraphicsInitOptions } from '../graphicsBackend/types'
import { LIGHT_OWNER_WORKER_SCRIPT } from '../three/clientLightOwner'
import Chunks from 'prismarine-chunk'

vi.mock('./ui/newStats', () => ({
  addNewStat: vi.fn(() => ({ updateText: vi.fn(), setVisibility: vi.fn() })),
  updateStatText: vi.fn(),
  removeAllStats: vi.fn(),
  updatePanesVisibility: vi.fn(),
  MC_RENDERER_DEBUG_OVERLAY_CLASS: 'mc-renderer-debug-overlay'
}))

vi.mock('./utils/skins', () => ({
  setSkinsConfig: vi.fn(),
  steveTexture: {},
  stevePngUrl: ''
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

  changeBackgroundColor() {}
  changeCardinalLight() {}
  handleWorkerMessage() {}
  updateCamera() {}
  render() {}
  updateShowChunksBorder() {}
  updatePlayerEntity() {}
  worldStop() {}
}

const constructedScripts: string[] = []

function createRenderer(enableOwner = false, workerCount = 2) {
  const rendererState = proxy({
    world: {
      chunksLoaded: {} as Record<string, true>,
      heightmaps: {} as Record<string, Int16Array>,
      allChunksLoaded: false,
      mesherWork: false,
      instabilityFactors: defaultPerformanceInstabilityFactors(),
      intersectMedia: null
    },
    renderer: '',
    preventEscapeMenu: false
  })

  const displayOptions: DisplayWorldOptions = {
    version: '1.17.1',
    worldView: Object.assign(new EventEmitter(), { reloadLoadedChunks: vi.fn(async () => {}) }) as DisplayWorldOptions['worldView'],
    inWorldRenderingConfig: proxy({ ...defaultWorldRendererConfig, mesherWorkers: workerCount, enableClientLightOwner: enableOwner }),
    playerStateReactive: getInitialPlayerState(),
    rendererState,
    nonReactiveState: {
      fps: 0,
      worstRenderTime: 0,
      avgRenderTime: 0,
      world: {
        chunksLoadedCount: 0,
        chunksTotalNumber: 0,
        chunksFullInfo: ''
      },
      renderer: {
        timeline: { live: [], frozen: [], lastSecond: [] }
      }
    },
    resourcesManager: {
      currentResources: {
        mcData: { version: {} },
        blocksAtlasJson: {},
        blockstatesModels: {}
      }
    } as DisplayWorldOptions['resourcesManager']
  }

  const initOptions: GraphicsInitOptions = {
    config: { sceneBackground: '#000' },
    rendererSpecificSettings: {},
    callbacks: {
      displayCriticalError: vi.fn(),
      setRendererSpecificSettings: vi.fn(),
      fireCustomEvent: vi.fn()
    }
  }

  const renderer = new TestWorldRenderer(displayOptions.resourcesManager, displayOptions, initOptions)
  renderer.active = true
  renderer.viewDistance = 8
  renderer.viewerChunkPosition = new Vec3(0, 64, 0)
  renderer.worldSizeParams = { minY: 0, worldHeight: 256 }
  return renderer
}

describe('WorldRendererCommon client light owner spawn', () => {
  beforeEach(() => {
    ensurePromiseWithResolvers()
    constructedScripts.length = 0
    vi.stubGlobal('location', { href: 'http://localhost/' })
    vi.stubGlobal(
      'Worker',
      class MockWorker {
        script: string
        postMessage = vi.fn()
        terminate = vi.fn()
        addEventListener = vi.fn()
        onmessage: ((event: MessageEvent) => void) | null = null
        constructor(script: string) {
          this.script = script
          constructedScripts.push(script)
        }
      }
    )
    vi.spyOn(worldRendererModule, 'meshersSendMcData').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  test('flag-off initWorkers does not spawn the light-owner worker', () => {
    const renderer = createRenderer(false, 2)
    renderer.initWorkers(2)
    expect(renderer.workers).toHaveLength(2)
    expect(constructedScripts.every(script => script !== LIGHT_OWNER_WORKER_SCRIPT)).toBe(true)
    expect(renderer.hasClientLightOwner()).toBe(false)
    expect(defaultWorldRendererConfig.enableClientLightOwner).toBe(false)
  })

  test('flag-on initWorkers spawns a dedicated owner, not a mesh worker', () => {
    const renderer = createRenderer(true, 2)
    renderer.initWorkers(2)
    expect(renderer.workers).toHaveLength(2)
    expect(constructedScripts.filter(script => script === LIGHT_OWNER_WORKER_SCRIPT)).toHaveLength(1)
    expect(constructedScripts.filter(script => script !== LIGHT_OWNER_WORKER_SCRIPT)).toHaveLength(2)
    expect(renderer.hasClientLightOwner()).toBe(true)
  })

  test('flag-off setBlock / addColumn / removeColumn do not post to an owner worker', () => {
    const renderer = createRenderer(false, 2)
    renderer.initWorkers(2)
    const ownerPosts = constructedScripts.map((_, i) => i).filter(i => constructedScripts[i] === LIGHT_OWNER_WORKER_SCRIPT)
    expect(ownerPosts).toHaveLength(0)

    const meshPosts = renderer.workers.map((w: { postMessage: ReturnType<typeof vi.fn> }) => w.postMessage)
    renderer.loadedChunks['0,0'] = true
    renderer.setBlockStateIdInner(new Vec3(1, 64, 1), 1)
    renderer.removeColumn(0, 0)

    expect(meshPosts.some(fn => fn.mock.calls.length > 0)).toBe(true)
    expect(renderer.hasClientLightOwner()).toBe(false)
  })

  test('flag-on setBlock / addColumn / removeColumn / update_light forward to the owner', () => {
    const renderer = createRenderer(true, 2)
    renderer.initWorkers(2)
    const owner = renderer.getClientLightOwnerWorker() as { postMessage: ReturnType<typeof vi.fn> }
    expect(owner).toBeTruthy()
    owner.postMessage.mockClear()

    renderer.loadedChunks['0,0'] = true
    renderer.setBlockStateIdInner(new Vec3(8, 64, 8), 2)
    const Chunk = Chunks('1.17.1') as any
    renderer.addColumn(0, 0, new Chunk().toJson(), false)
    renderer.removeColumn(0, 0)
    renderer.feedChunkPacket({
      kind: 'setUpdateLightV17',
      protocol: 756,
      numSections: 16,
      rawPacket: new Uint8Array([1, 2, 3])
    })

    const payloads = owner.postMessage.mock.calls.map(call => call[0])
    expect(payloads.some(p => p?.type === 'pushEvent' && p.event?.type === 'blockChange')).toBe(true)
    expect(payloads.some(p => p?.type === 'pushEvent' && p.event?.type === 'ingestBlockSection')).toBe(true)
    expect(payloads.some(p => p?.type === 'pushEvent' && p.event?.type === 'unloadColumn')).toBe(true)
    expect(payloads.some(p => p?.type === 'setUpdateLightV17')).toBe(true)
  })

  test('resetWorld terminates the owner worker when it was spawned', () => {
    const renderer = createRenderer(true, 1)
    renderer.initWorkers(1)
    const owner = renderer.getClientLightOwnerWorker() as { terminate: ReturnType<typeof vi.fn> }
    expect(owner).toBeTruthy()
    renderer.resetWorld()
    expect(owner.terminate).toHaveBeenCalled()
    expect(renderer.hasClientLightOwner()).toBe(false)
    expect(renderer.workers).toHaveLength(0)
  })
})
