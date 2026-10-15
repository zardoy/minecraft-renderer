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
import { INITIAL_TOPOLOGY_REVISION } from './clientLightVersions'
import { clearTopologyPostCache, getOrComputeTopologyPost } from '../wasm-mesher/worker/mesherWasmTopologyPostCache'
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

function createRenderer(enableOwner = false, workerCount = 2, version = '1.17.1') {
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
    version,
    worldView: Object.assign(new EventEmitter(), { reloadLoadedChunks: vi.fn(async () => {}) }) as unknown as DisplayWorldOptions['worldView'],
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

  test('flag-on on a non-1.17.1 session does not load the 1.17.1 tables', () => {
    const renderer = createRenderer(true, 1, '1.16.5')
    renderer.initWorkers(1)
    expect(renderer.workers).toHaveLength(1)
    expect(constructedScripts.every(script => script !== LIGHT_OWNER_WORKER_SCRIPT)).toBe(true)
    expect(renderer.getClientLightOwnerWorker()).toBeNull()
    expect(renderer.hasClientLightOwner()).toBe(false)
    expect(renderer.getClientLightOwnerFailureReason()).toMatch(/1\.17\.1/)
  })

  test('flag-on initWorkers spawns a dedicated owner, not a mesh worker', () => {
    const renderer = createRenderer(true, 2)
    renderer.initWorkers(2)
    expect(renderer.workers).toHaveLength(2)
    expect(constructedScripts.filter(script => script === LIGHT_OWNER_WORKER_SCRIPT)).toHaveLength(1)
    expect(constructedScripts.filter(script => script !== LIGHT_OWNER_WORKER_SCRIPT)).toHaveLength(2)
    expect(renderer.getClientLightOwnerWorker()).toBeTruthy()
    expect(renderer.hasClientLightOwner()).toBe(false)
  })

  test('flag-on owner is not working until the worker reports ready', () => {
    const renderer = createRenderer(true, 1)
    renderer.initWorkers(1)
    expect(renderer.hasClientLightOwner()).toBe(false)
    const owner = renderer.getClientLightOwnerWorker() as { onmessage: ((event: MessageEvent) => void) | null }
    owner.onmessage?.({ data: { type: 'ready' } } as MessageEvent)
    expect(renderer.hasClientLightOwner()).toBe(true)
  })

  test('flag-on owner goes failed on worker error and is not working', () => {
    const renderer = createRenderer(true, 1)
    renderer.initWorkers(1)
    const owner = renderer.getClientLightOwnerWorker() as { onmessage: ((event: MessageEvent) => void) | null }
    owner.onmessage?.({ data: { type: 'error', error: 'NetworkError loading lightOwnerWorker.js' } } as MessageEvent)
    expect(renderer.hasClientLightOwner()).toBe(false)
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

  test('startup light stays bulk; a later publication of an edited section stays urgent', () => {
    const renderer = createRenderer(true, 1)
    renderer.initWorkers(1)
    renderer.forceCallFromMesherReplayer = true
    renderer.neighborChunkUpdates = false
    renderer.loadedChunks['0,0'] = true
    renderer.loadedChunks['64,64'] = true
    const owner = renderer.getClientLightOwnerWorker() as { onmessage: ((event: MessageEvent) => void) | null }
    owner.onmessage?.({ data: { type: 'ready' } } as MessageEvent)
    const mesh = renderer.workers[0] as { postMessage: ReturnType<typeof vi.fn> }
    const publish = (version: number, sx: number, sy: number, sz: number) => {
      owner.onmessage?.({
        data: {
          type: 'publication',
          publication: {
            worldGeneration: 1,
            publicationVersion: version,
            sections: [{ sx, sy, sz, blockLight: new Uint8Array(2048) }]
          }
        }
      } as MessageEvent)
    }
    const dirties = () => mesh.postMessage.mock.calls.map(call => call[0]).filter((message: { type?: string }) => message?.type === 'dirty')

    mesh.postMessage.mockClear()
    publish(1, 0, 4, 0)
    const startup = dirties()
    expect(startup.length).toBeGreaterThan(0)
    expect(startup.every((message: { urgent?: boolean }) => message.urgent !== true)).toBe(true)

    mesh.postMessage.mockClear()
    renderer.setBlockStateIdInner(new Vec3(1, 64, 1), 1)
    const editDirties = dirties()
    expect(editDirties.length).toBeGreaterThan(0)
    expect(editDirties.every((message: { urgent?: boolean }) => message.urgent === true)).toBe(true)

    mesh.postMessage.mockClear()
    publish(2, 0, 4, 0)
    const covering = dirties()
    expect(covering.length).toBeGreaterThan(0)
    expect(covering.every((message: { urgent?: boolean }) => message.urgent === true)).toBe(true)

    mesh.postMessage.mockClear()
    publish(3, 4, 4, 4)
    const unrelated = dirties()
    expect(unrelated.length).toBeGreaterThan(0)
    expect(unrelated.every((message: { urgent?: boolean }) => message.urgent !== true)).toBe(true)
  })

  test('geometry at the pre-edit light version keeps the edit urgent until its own publication is committed', () => {
    const renderer = createRenderer(true, 1)
    renderer.initWorkers(1)
    renderer.forceCallFromMesherReplayer = true
    renderer.neighborChunkUpdates = false
    renderer.loadedChunks['0,0'] = true
    const owner = renderer.getClientLightOwnerWorker() as { onmessage: ((event: MessageEvent) => void) | null }
    owner.onmessage?.({ data: { type: 'ready' } } as MessageEvent)
    const mesh = renderer.workers[0] as { postMessage: ReturnType<typeof vi.fn> }
    const publish = (version: number) => {
      owner.onmessage?.({
        data: {
          type: 'publication',
          publication: {
            worldGeneration: 1,
            publicationVersion: version,
            sections: [{ sx: 0, sy: 4, sz: 0, blockLight: new Uint8Array(2048) }]
          }
        }
      } as MessageEvent)
    }
    const dirties = () => mesh.postMessage.mock.calls.map(call => call[0]).filter((message: { type?: string }) => message?.type === 'dirty')
    publish(5)
    renderer.setBlockStateIdInner(new Vec3(1, 64, 1), 1)
    const topology = (renderer as any).topologyRevisionBySection.get('0,64,0') as number
    const geometry = {
      type: 'geometry',
      key: '0,64,0',
      worldGeneration: 1,
      lightPublicationVersion: 5,
      sessionEpoch: 1,
      columnIncarnation: 1,
      requestId: 1,
      topologyRevision: topology,
      meshMode: 'owner' as const,
      workerIndex: 0,
      geometry: {}
    }
    const early = (renderer as any).evaluateOwnerGeometry(geometry)
    expect(early.accepted).toBe(true)
    expect(early.keepCovering).toBe(false)
    renderer.handleMessage(geometry)
    owner.onmessage?.({ data: { type: 'stepped', remaining: false, stepGeneration: 0 } } as MessageEvent)
    mesh.postMessage.mockClear()
    publish(6)
    const covering = dirties()
    expect(covering.length).toBeGreaterThan(0)
    expect(covering.every((message: { urgent?: boolean }) => message.urgent === true)).toBe(true)

    renderer.handleMessage({ ...geometry, lightPublicationVersion: 6 })
    mesh.postMessage.mockClear()
    publish(7)
    const afterCommit = dirties()
    expect(afterCommit.length).toBeGreaterThan(0)
    expect(afterCommit.every((message: { urgent?: boolean }) => message.urgent !== true)).toBe(true)
  })

  test('a second urgent edit in the throttle window is dispatched immediately', () => {
    vi.useFakeTimers()
    try {
      const renderer = createRenderer(true, 1)
      renderer.initWorkers(1)
      renderer.forceCallFromMesherReplayer = true
      renderer.neighborChunkUpdates = false
      renderer.loadedChunks['0,0'] = true
      const owner = renderer.getClientLightOwnerWorker() as { onmessage: ((event: MessageEvent) => void) | null }
      owner.onmessage?.({ data: { type: 'ready' } } as MessageEvent)
      const mesh = renderer.workers[0] as { postMessage: ReturnType<typeof vi.fn> }
      renderer.setBlockStateIdInner(new Vec3(1, 64, 1), 1)
      mesh.postMessage.mockClear()
      renderer.setBlockStateIdInner(new Vec3(2, 64, 1), 2)
      const second = mesh.postMessage.mock.calls.map(call => call[0]).filter((message: { type?: string }) => message?.type === 'dirty')
      expect(second.length).toBeGreaterThan(0)
      expect(second.every((message: { urgent?: boolean }) => message.urgent === true)).toBe(true)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  test('flag-on setBlock / addColumn / removeColumn / update_light forward to the owner', () => {
    const renderer = createRenderer(true, 2)
    renderer.initWorkers(2)
    const owner = renderer.getClientLightOwnerWorker() as unknown as { postMessage: ReturnType<typeof vi.fn> }
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
    const owner = renderer.getClientLightOwnerWorker() as unknown as { terminate: ReturnType<typeof vi.fn> }
    expect(owner).toBeTruthy()
    renderer.resetWorld()
    expect(owner.terminate).toHaveBeenCalled()
    expect(renderer.hasClientLightOwner()).toBe(false)
    expect(renderer.workers).toHaveLength(0)
  })

  test('owner publication remesh does not wait the 100ms trailing window', () => {
    vi.useFakeTimers()
    try {
      const renderer = createRenderer(true, 1)
      renderer.initWorkers(1)
      renderer.forceCallFromMesherReplayer = true
      const mesh = renderer.workers[0] as { postMessage: ReturnType<typeof vi.fn> }
      renderer.setSectionDirty(new Vec3(0, 64, 0), true, true)
      mesh.postMessage.mockClear()
      ;(renderer as any).onClientLightOwnerPublication({
        applied: true,
        lastVersion: 7,
        acceptedGeneration: 1,
        dirtyMeshSections: [{ sx: 0, sy: 64, sz: 0 }],
        workerMessage: null
      })
      const immediate = mesh.postMessage.mock.calls.map(call => call[0]).filter((message: { type?: string }) => message?.type === 'dirty')
      expect(immediate.some((message: { lightPublicationVersion?: number }) => message.lightPublicationVersion === 7)).toBe(true)
      mesh.postMessage.mockClear()
      vi.advanceTimersByTime(WorldRendererCommon['GEOMETRY_THROTTLE_DELAY'])
      const trailing = mesh.postMessage.mock.calls.map(call => call[0]).filter((message: { type?: string }) => message?.type === 'dirty')
      expect(trailing).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  test('owner publication is posted only to mesh workers that own dirty sections', () => {
    const renderer = createRenderer(true, 8)
    renderer.initWorkers(8)
    for (const worker of renderer.workers) {
      ;(worker as { postMessage: ReturnType<typeof vi.fn> }).postMessage.mockClear()
    }
    const workerMessage = {
      type: 'applyOwnerLightPublication',
      worldGeneration: 1,
      publicationVersion: 4,
      sections: [{ sx: 0, sy: 64, sz: 0, blockLight: new Uint8Array(2048) }]
    }
    ;(renderer as any).onClientLightOwnerPublication({
      applied: true,
      lastVersion: 4,
      acceptedGeneration: 1,
      dirtyMeshSections: [{ sx: 0, sy: 64, sz: 0 }],
      workerMessage
    })
    const posted = renderer.workers.map(worker =>
      (worker as { postMessage: ReturnType<typeof vi.fn> }).postMessage.mock.calls.some(call => call[0]?.type === 'applyOwnerLightPublication')
    )
    expect(posted.filter(Boolean).length).toBeGreaterThan(0)
    expect(posted.filter(Boolean).length).toBeLessThan(renderer.workers.length)
  })

  test('trailing dirty after an owner publication keeps the target revision', () => {
    vi.useFakeTimers()
    try {
      const renderer = createRenderer(true, 1)
      renderer.initWorkers(1)
      renderer.forceCallFromMesherReplayer = true
      const mesh = renderer.workers[0] as { postMessage: ReturnType<typeof vi.fn> }
      mesh.postMessage.mockClear()
      renderer.setSectionDirty(new Vec3(0, 64, 0), true, true)
      ;(renderer as any).onClientLightOwnerPublication({
        applied: true,
        lastVersion: 7,
        acceptedGeneration: 1,
        dirtyMeshSections: [{ sx: 0, sy: 64, sz: 0 }],
        workerMessage: null
      })
      vi.advanceTimersByTime(WorldRendererCommon['GEOMETRY_THROTTLE_DELAY'])
      const dirties = mesh.postMessage.mock.calls.map(call => call[0]).filter((message: { type?: string }) => message?.type === 'dirty')
      const trailing = dirties.at(-1)
      expect(trailing?.lightPublicationVersion).toBe(7)
      expect(trailing?.worldGeneration).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test('rejected stale owner geometry does not add a remesh when covering is already outstanding', () => {
    const renderer = createRenderer(true, 1)
    renderer.initWorkers(1)
    renderer.forceCallFromMesherReplayer = true
    renderer.loadedChunks['0,0'] = true
    const owner = renderer.getClientLightOwnerWorker() as { onmessage: ((event: MessageEvent) => void) | null }
    owner.onmessage?.({ data: { type: 'ready' } } as MessageEvent)
    owner.onmessage?.({
      data: {
        type: 'publication',
        publication: {
          worldGeneration: 1,
          publicationVersion: 2,
          sections: [{ sx: 0, sy: 4, sz: 0, blockLight: new Uint8Array(2048) }]
        }
      }
    } as MessageEvent)

    const mesh = renderer.workers[0] as { postMessage: ReturnType<typeof vi.fn> }
    mesh.postMessage.mockClear()
    renderer.sectionsWaiting.set('0,64,0', 1)
    renderer.handleMessage({
      type: 'geometry',
      key: '0,64,0',
      worldGeneration: 1,
      lightPublicationVersion: 1,
      sessionEpoch: 1,
      columnIncarnation: 1,
      requestId: 1,
      topologyRevision: 1,
      workerIndex: 0,
      geometry: {}
    })
    const dirties = mesh.postMessage.mock.calls.map(call => call[0]).filter((message: { type?: string }) => message?.type === 'dirty')
    expect(dirties).toHaveLength(0)

    renderer.handleMessage({ type: 'sectionFinished', key: '0,64,0', workerIndex: 0, processTime: 0 })
    const replacement = mesh.postMessage.mock.calls.map(call => call[0]).filter((message: { type?: string }) => message?.type === 'dirty')
    expect(replacement).toHaveLength(1)
    expect(replacement[0]?.lightPublicationVersion).toBe(2)
    expect(renderer.sectionsWaiting.get('0,64,0')).toBe(1)
    expect((renderer as any).rejectedFinishedBySection.get('0,64,0') ?? 0).toBe(0)
  })

  test('fast A→B→C drops B and keeps a single covering remesh for C', () => {
    const renderer = createRenderer(true, 1)
    renderer.initWorkers(1)
    renderer.forceCallFromMesherReplayer = true
    renderer.loadedChunks['0,0'] = true
    const owner = renderer.getClientLightOwnerWorker() as { onmessage: ((event: MessageEvent) => void) | null }
    owner.onmessage?.({ data: { type: 'ready' } } as MessageEvent)
    const publish = (version: number) => {
      owner.onmessage?.({
        data: {
          type: 'publication',
          publication: {
            worldGeneration: 1,
            publicationVersion: version,
            sections: [{ sx: 0, sy: 4, sz: 0, blockLight: new Uint8Array(2048) }]
          }
        }
      } as MessageEvent)
    }
    publish(1)
    publish(2)
    publish(3)
    const mesh = renderer.workers[0] as { postMessage: ReturnType<typeof vi.fn> }
    mesh.postMessage.mockClear()
    renderer.sectionsWaiting.set('0,64,0', 1)
    renderer.handleMessage({
      type: 'geometry',
      key: '0,64,0',
      worldGeneration: 1,
      lightPublicationVersion: 2,
      sessionEpoch: 1,
      columnIncarnation: 1,
      requestId: 2,
      topologyRevision: 1,
      workerIndex: 0,
      geometry: {}
    })
    expect(mesh.postMessage.mock.calls.filter(call => call[0]?.type === 'dirty')).toHaveLength(0)
    const accepted = (renderer as any).evaluateOwnerGeometry({
      type: 'geometry',
      key: '0,64,0',
      worldGeneration: 1,
      lightPublicationVersion: 3,
      sessionEpoch: 1,
      columnIncarnation: 1,
      requestId: 3,
      topologyRevision: 1,
      geometry: {}
    })
    expect(accepted.accepted).toBe(true)
  })

  test('owner failure posts a revert to mesh workers and rejects later owner publications', () => {
    const renderer = createRenderer(true, 1)
    renderer.initWorkers(1)
    renderer.forceCallFromMesherReplayer = true
    const owner = renderer.getClientLightOwnerWorker() as { onmessage: ((event: MessageEvent) => void) | null }
    owner.onmessage?.({ data: { type: 'ready' } } as MessageEvent)
    const mesh = renderer.workers[0] as { postMessage: ReturnType<typeof vi.fn> }
    mesh.postMessage.mockClear()
    owner.onmessage?.({ data: { type: 'error', error: 'owner wasm crashed' } } as MessageEvent)
    expect(renderer.hasClientLightOwner()).toBe(false)
    expect((renderer as any).getClientLightOwnerFailureReason()).toBe('owner wasm crashed')
    expect(mesh.postMessage.mock.calls.some(call => call[0]?.type === 'revertOwnerLightToIncoming')).toBe(true)
    const late = (renderer as any).evaluateOwnerGeometry({
      type: 'geometry',
      key: '0,64,0',
      worldGeneration: 1,
      lightPublicationVersion: 9,
      sessionEpoch: 1,
      meshMode: 'owner',
      geometry: {}
    })
    expect(late.accepted).toBe(false)
  })

  test('reload of the same column increments incarnation so a late reply is dropped', () => {
    const renderer = createRenderer(true, 1)
    renderer.initWorkers(1)
    renderer.forceCallFromMesherReplayer = true
    renderer.loadedChunks['0,0'] = true
    const owner = renderer.getClientLightOwnerWorker() as { onmessage: ((event: MessageEvent) => void) | null }
    owner.onmessage?.({ data: { type: 'ready' } } as MessageEvent)
    const first = (renderer as any).columnIncarnationFor('0,0')
    renderer.removeColumn(0, 0)
    renderer.loadedChunks['0,0'] = true
    const second = (renderer as any).columnIncarnationFor('0,0')
    expect(second).toBeGreaterThan(first ?? 0)
    const late = (renderer as any).evaluateOwnerGeometry({
      type: 'geometry',
      key: '0,64,0',
      worldGeneration: 1,
      lightPublicationVersion: 4,
      sessionEpoch: 1,
      columnIncarnation: first ?? 1,
      requestId: 4,
      topologyRevision: 1,
      meshMode: 'owner',
      geometry: {}
    })
    expect(late.accepted).toBe(false)
  })

  test('flag-on ready owner does not fan-out raw update_light to mesh workers', () => {
    const renderer = createRenderer(true, 2)
    renderer.initWorkers(2)
    const owner = renderer.getClientLightOwnerWorker() as unknown as {
      onmessage: ((event: MessageEvent) => void) | null
      postMessage: ReturnType<typeof vi.fn>
    }
    owner.onmessage?.({ data: { type: 'ready' } } as MessageEvent)
    owner.postMessage.mockClear()
    for (const worker of renderer.workers) {
      ;(worker as { postMessage: ReturnType<typeof vi.fn> }).postMessage.mockClear()
    }
    renderer.feedChunkPacket({
      kind: 'setUpdateLightV17',
      protocol: 756,
      numSections: 16,
      rawPacket: new Uint8Array([1, 2, 3])
    })
    expect(owner.postMessage.mock.calls.some(call => call[0]?.type === 'setUpdateLightV17')).toBe(true)
    expect(
      renderer.workers.every(worker =>
        (worker as { postMessage: ReturnType<typeof vi.fn> }).postMessage.mock.calls.every(call => call[0]?.type !== 'setUpdateLightV17')
      )
    ).toBe(true)
  })

  test('stale topology with fresh light is rejected and covering stays outstanding', () => {
    const renderer = createRenderer(true, 1)
    renderer.initWorkers(1)
    renderer.forceCallFromMesherReplayer = true
    renderer.neighborChunkUpdates = false
    renderer.loadedChunks['0,0'] = true
    const owner = renderer.getClientLightOwnerWorker() as { onmessage: ((event: MessageEvent) => void) | null }
    owner.onmessage?.({ data: { type: 'ready' } } as MessageEvent)
    renderer.setBlockStateIdInner(new Vec3(1, 64, 1), 1)
    renderer.setBlockStateIdInner(new Vec3(1, 64, 1), 2)
    const topology = (renderer as any).topologyRevisionBySection.get('0,64,0') as number
    expect(topology).toBeGreaterThan(1)
    owner.onmessage?.({
      data: {
        type: 'publication',
        publication: {
          worldGeneration: 1,
          publicationVersion: 4,
          sections: [{ sx: 0, sy: 4, sz: 0, blockLight: new Uint8Array(2048) }]
        }
      }
    } as MessageEvent)
    expect((renderer as any).clientLightOwnerSession.requiredLightForSection('0,64,0')?.topologyRevision).toBe(topology)
    const mesh = renderer.workers[0] as { postMessage: ReturnType<typeof vi.fn> }
    mesh.postMessage.mockClear()
    renderer.sectionsWaiting.set('0,64,0', 1)
    renderer.handleMessage({
      type: 'geometry',
      key: '0,64,0',
      worldGeneration: 1,
      lightPublicationVersion: 4,
      sessionEpoch: 1,
      columnIncarnation: 1,
      requestId: 1,
      topologyRevision: topology - 1,
      workerIndex: 0,
      geometry: {}
    })
    expect(
      (renderer as any).evaluateOwnerGeometry({
        type: 'geometry',
        key: '0,64,0',
        worldGeneration: 1,
        lightPublicationVersion: 4,
        sessionEpoch: 1,
        columnIncarnation: 1,
        topologyRevision: topology - 1,
        geometry: {}
      }).accepted
    ).toBe(false)
    expect(mesh.postMessage.mock.calls.filter(call => call[0]?.type === 'dirty')).toHaveLength(0)
    expect((renderer as any).pendingTopologyBySection.get('0,64,0')).toBe(topology)
    renderer.handleMessage({ type: 'sectionFinished', key: '0,64,0', workerIndex: 0, processTime: 0 })
    const replacement = mesh.postMessage.mock.calls.map(call => call[0]).filter((message: { type?: string }) => message?.type === 'dirty')
    expect(replacement).toHaveLength(1)
    expect(replacement[0]?.topologyRevision).toBe(topology)
    expect(replacement[0]?.lightPublicationVersion).toBe(4)
    expect(renderer.sectionsWaiting.get('0,64,0')).toBe(1)
    expect((renderer as any).pendingTopologyBySection.get('0,64,0')).toBe(topology)
  })

  test('fresh topology with stale light installs and keeps covering without a second dispatch', () => {
    const renderer = createRenderer(true, 1)
    renderer.initWorkers(1)
    renderer.forceCallFromMesherReplayer = true
    renderer.neighborChunkUpdates = false
    renderer.loadedChunks['0,0'] = true
    const owner = renderer.getClientLightOwnerWorker() as { onmessage: ((event: MessageEvent) => void) | null }
    owner.onmessage?.({ data: { type: 'ready' } } as MessageEvent)
    renderer.setBlockStateIdInner(new Vec3(1, 64, 1), 1)
    const topology = (renderer as any).topologyRevisionBySection.get('0,64,0') as number
    owner.onmessage?.({
      data: {
        type: 'publication',
        publication: {
          worldGeneration: 1,
          publicationVersion: 3,
          sections: [{ sx: 0, sy: 4, sz: 0, blockLight: new Uint8Array(2048) }]
        }
      }
    } as MessageEvent)
    const mesh = renderer.workers[0] as { postMessage: ReturnType<typeof vi.fn> }
    mesh.postMessage.mockClear()
    renderer.sectionsWaiting.set('0,64,0', 2)
    renderer.handleMessage({
      type: 'geometry',
      key: '0,64,0',
      worldGeneration: 1,
      lightPublicationVersion: 1,
      sessionEpoch: 1,
      columnIncarnation: 1,
      requestId: 1,
      topologyRevision: topology,
      workerIndex: 0,
      geometry: {}
    })
    const decision = (renderer as any).evaluateOwnerGeometry({
      type: 'geometry',
      key: '0,64,0',
      worldGeneration: 1,
      lightPublicationVersion: 1,
      sessionEpoch: 1,
      columnIncarnation: 1,
      topologyRevision: topology,
      geometry: {}
    })
    expect(decision.accepted).toBe(true)
    expect(decision.keepCovering).toBe(true)
    expect(mesh.postMessage.mock.calls.filter(call => call[0]?.type === 'dirty')).toHaveLength(0)
    expect((renderer as any).pendingCoveringBySection.has('0,64,0')).toBe(true)
    expect((renderer as any).pendingTopologyBySection.has('0,64,0')).toBe(false)
    renderer.handleMessage({ type: 'sectionFinished', key: '0,64,0', workerIndex: 0, processTime: 0 })
    expect(renderer.sectionsWaiting.get('0,64,0')).toBe(1)
    expect((renderer as any).pendingCoveringBySection.has('0,64,0')).toBe(true)
  })

  test('fast A→B→C publications keep the max topology revision', () => {
    const renderer = createRenderer(true, 1)
    renderer.initWorkers(1)
    renderer.forceCallFromMesherReplayer = true
    renderer.neighborChunkUpdates = false
    renderer.loadedChunks['0,0'] = true
    const owner = renderer.getClientLightOwnerWorker() as { onmessage: ((event: MessageEvent) => void) | null }
    owner.onmessage?.({ data: { type: 'ready' } } as MessageEvent)
    const publish = (version: number) => {
      owner.onmessage?.({
        data: {
          type: 'publication',
          publication: {
            worldGeneration: 1,
            publicationVersion: version,
            sections: [{ sx: 0, sy: 4, sz: 0, blockLight: new Uint8Array(2048) }]
          }
        }
      } as MessageEvent)
    }
    renderer.setBlockStateIdInner(new Vec3(1, 64, 1), 1)
    publish(1)
    renderer.setBlockStateIdInner(new Vec3(1, 64, 1), 2)
    publish(2)
    renderer.setBlockStateIdInner(new Vec3(1, 64, 1), 3)
    publish(3)
    const topology = (renderer as any).topologyRevisionBySection.get('0,64,0')
    expect((renderer as any).clientLightOwnerSession.requiredLightForSection('0,64,0')).toMatchObject({
      requiredVersion: 3,
      worldGeneration: 1,
      topologyRevision: topology
    })
  })

  test('publishing light only for column A accepts the neighbor wall without a publication of B', () => {
    const renderer = createRenderer(true, 2)
    renderer.initWorkers(2)
    renderer.forceCallFromMesherReplayer = true
    renderer.loadedChunks['0,0'] = true
    renderer.loadedChunks['16,0'] = true
    renderer.loadedChunks['-16,0'] = true
    const owner = renderer.getClientLightOwnerWorker() as { onmessage: ((event: MessageEvent) => void) | null }
    owner.onmessage?.({ data: { type: 'ready' } } as MessageEvent)
    owner.onmessage?.({
      data: {
        type: 'publication',
        publication: {
          worldGeneration: 1,
          publicationVersion: 8,
          sections: [{ sx: 0, sy: 4, sz: 0, blockLight: new Uint8Array(2048) }]
        }
      }
    } as MessageEvent)

    const posted = renderer.workers.map(worker =>
      (worker as { postMessage: ReturnType<typeof vi.fn> }).postMessage.mock.calls.some(call => call[0]?.type === 'applyOwnerLightPublication')
    )
    expect(posted).toEqual([true, true])
    expect((renderer as any).clientLightOwnerSession.requiredLightForSection('16,64,0')?.requiredVersion).toBe(8)
    expect((renderer as any).clientLightOwnerSession.requiredLightForSection('-16,64,0')?.requiredVersion).toBe(8)

    const evaluate = (key: string, lightPublicationVersion: number, meshMode: 'owner' | 'legacyBootstrap') => {
      const [x, , z] = key.split(',').map(Number)
      return (renderer as any).evaluateOwnerGeometry({
        type: 'geometry',
        key,
        worldGeneration: 1,
        lightPublicationVersion,
        sessionEpoch: 1,
        columnIncarnation: renderer.columnIncarnationFor(`${x},${z}`),
        requestId: 1,
        topologyRevision: INITIAL_TOPOLOGY_REVISION,
        meshMode,
        geometry: {}
      })
    }

    const bootstrapWall = evaluate('-16,64,0', 8, 'legacyBootstrap')
    expect(bootstrapWall.accepted).toBe(true)
    expect(bootstrapWall.keepCovering).toBe(false)
    expect(evaluate('16,64,0', 3, 'owner').accepted).toBe(false)
    expect(evaluate('16,64,0', 8, 'owner').accepted).toBe(true)
  })

  test('bootstrap geometry from the previous column life is rejected', () => {
    const renderer = createRenderer(true, 1)
    renderer.initWorkers(1)
    renderer.forceCallFromMesherReplayer = true
    renderer.loadedChunks['0,0'] = true
    const owner = renderer.getClientLightOwnerWorker() as { onmessage: ((event: MessageEvent) => void) | null }
    owner.onmessage?.({ data: { type: 'ready' } } as MessageEvent)
    const first = renderer.columnIncarnationFor('0,0')
    renderer.removeColumn(0, 0)
    renderer.loadedChunks['0,0'] = true
    const late = (renderer as any).evaluateOwnerGeometry({
      type: 'geometry',
      key: '0,64,0',
      meshMode: 'legacyBootstrap',
      sessionEpoch: 1,
      columnIncarnation: first,
      geometry: {}
    })
    expect(late.accepted).toBe(false)
  })

  test('the first edit misses the initial topology cache and covering remesh carries the new revision', () => {
    vi.useFakeTimers()
    try {
      const renderer = createRenderer(true, 1)
      renderer.initWorkers(1)
      renderer.forceCallFromMesherReplayer = true
      renderer.neighborChunkUpdates = false
      renderer.loadedChunks['0,0'] = true
      const owner = renderer.getClientLightOwnerWorker() as { onmessage: ((event: MessageEvent) => void) | null }
      owner.onmessage?.({ data: { type: 'ready' } } as MessageEvent)
      const mesh = renderer.workers[0] as { postMessage: ReturnType<typeof vi.fn> }
      mesh.postMessage.mockClear()
      renderer.setSectionDirty(new Vec3(1, 64, 1), true, true)
      const initial = mesh.postMessage.mock.calls
        .map(call => call[0])
        .filter((message: { type?: string }) => message?.type === 'dirty')
        .at(-1)
      expect(initial?.topologyRevision).toBe(INITIAL_TOPOLOGY_REVISION)

      let walks = 0
      const compute = () => {
        walks++
        return { visibilitySet: walks, signs: {}, heads: {}, banners: {} }
      }
      getOrComputeTopologyPost('0,64,0', initial?.topologyRevision, compute)
      renderer.setBlockStateIdInner(new Vec3(1, 64, 1), 1)
      owner.onmessage?.({
        data: {
          type: 'publication',
          publication: {
            worldGeneration: 1,
            publicationVersion: 2,
            sections: [{ sx: 0, sy: 4, sz: 0, blockLight: new Uint8Array(2048) }]
          }
        }
      } as MessageEvent)
      const covering = mesh.postMessage.mock.calls
        .map(call => call[0])
        .filter((message: { type?: string; lightPublicationVersion?: number; x?: number; y?: number; z?: number }) => {
          if (message?.type !== 'dirty' || message.lightPublicationVersion !== 2) return false
          const sx = Math.floor((message.x ?? 0) / 16) * 16
          const sy = Math.floor((message.y ?? 0) / 16) * 16
          const sz = Math.floor((message.z ?? 0) / 16) * 16
          return `${sx},${sy},${sz}` === '0,64,0'
        })
      expect(covering).toHaveLength(1)
      expect(covering[0]?.topologyRevision).not.toBe(initial?.topologyRevision)
      const editedRevision = covering[0]?.topologyRevision
      const recomputed = getOrComputeTopologyPost('0,64,0', editedRevision, compute)
      expect(recomputed.hit).toBe(false)
      expect(walks).toBe(2)
    } finally {
      clearTopologyPostCache()
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
})
