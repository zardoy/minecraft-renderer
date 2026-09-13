import { describe, expect, it, vi } from 'vitest'
import Chunks from 'prismarine-chunk'
import MinecraftData from 'minecraft-data'
import { Vec3 } from 'vec3'
import { RendererLightCache } from './rendererLightCache'
import { defaultWorldRendererConfig } from '../graphicsBackend/config'
import { LightOwnerHost, type LightPublication, type PublicationGate } from './lightOwnerHost'
import { maskBitSet, worldSectionMaskBit, type ParsedUpdateLight } from '../wasm-mesher/worker/mesherWasmLightMerge'
import {
  applyOwnerPublicationToRenderer,
  blockChangeEvent,
  ClientLightOwnerSession,
  dirtyMeshSectionsFromChangedLight,
  eventsFromColumnLoad,
  meshWorkerIndexesForDirtySections,
  eventsFromColumnUnload,
  eventsFromParsedUpdateLight,
  packUnpackedLightSection,
  shouldAcceptMeshGeometry,
  shouldSpawnClientLightOwner,
  skyLightEnabledFromRendererState,
  unpackPackedLightSection
} from './clientLightOwner'

const VERSION = '1.17.1'

function packedNibble(value: number): Uint8Array {
  const n = value & 0x0f
  return new Uint8Array(2048).fill(n | (n << 4))
}

function makeAirColumnJson() {
  const Chunk = Chunks(VERSION) as any
  const chunk = new Chunk()
  return chunk.toJson()
}

function unpackedSection(value: number): Uint8Array {
  return new Uint8Array(4096).fill(value & 0x0f)
}

function makeSession() {
  let onMessage: (data: any) => void = () => {}
  const worker = {
    postMessage: () => {},
    terminate: () => {},
    onerror: null as ((event: ErrorEvent) => void) | null
  }
  const cache = new RendererLightCache(VERSION)
  cache.setWorldBounds(0, 256)
  const session = new ClientLightOwnerSession(cache, {
    createWorker: handler => {
      onMessage = handler
      return worker as unknown as Worker
    },
    worldMinY: 0,
    worldHeight: 256,
    skyLightEnabled: true,
    onApplied: () => {}
  })
  return { session, worker, deliver: (data: any) => onMessage(data) }
}

describe('client light owner flag', () => {
  it('stays default-off so production does not spawn the owner', () => {
    expect(defaultWorldRendererConfig.enableClientLightOwner).toBe(false)
    expect(shouldSpawnClientLightOwner(defaultWorldRendererConfig)).toBe(false)
  })

  it('spawns only when the flag is explicitly true', () => {
    expect(shouldSpawnClientLightOwner({ enableClientLightOwner: true })).toBe(true)
    expect(shouldSpawnClientLightOwner({ enableClientLightOwner: false })).toBe(false)
    expect(shouldSpawnClientLightOwner({})).toBe(false)
  })
})

describe('client light owner lifecycle', () => {
  it('starts in starting and is not ready until the worker reports ready', () => {
    const { session } = makeSession()
    expect(session.state).toBe('starting')
    expect(session.isReady).toBe(false)
  })

  it('becomes ready after the worker ready message', () => {
    const { session, deliver } = makeSession()
    deliver({ type: 'ready' })
    expect(session.state).toBe('ready')
    expect(session.isReady).toBe(true)
  })

  it('goes to failed on a worker error message', () => {
    const { session, deliver } = makeSession()
    deliver({ type: 'error', error: 'NetworkError loading lightOwnerWorker.js' })
    expect(session.state).toBe('failed')
    expect(session.isReady).toBe(false)
  })

  it('goes to failed on worker onerror (script 404)', () => {
    const { session, worker } = makeSession()
    expect(typeof worker.onerror).toBe('function')
    worker.onerror?.({ type: 'error', message: 'NetworkError' } as ErrorEvent)
    expect(session.state).toBe('failed')
    expect(session.isReady).toBe(false)
  })

  it('does not leave failed after a late ready', () => {
    const { session, deliver } = makeSession()
    deliver({ type: 'error', error: 'init failed' })
    deliver({ type: 'ready' })
    expect(session.state).toBe('failed')
  })
})

describe('owner step scheduling', () => {
  it('does not bounce remaining slices through main setTimeout', () => {
    vi.useFakeTimers()
    try {
      const posts: Array<{ type?: string }> = []
      let onMessage: (data: any) => void = () => {}
      const worker = {
        postMessage: (message: { type?: string }) => {
          posts.push(message)
        },
        terminate: () => {},
        onerror: null as ((event: ErrorEvent) => void) | null
      }
      const cache = new RendererLightCache(VERSION)
      cache.setWorldBounds(0, 256)
      const session = new ClientLightOwnerSession(cache, {
        createWorker: handler => {
          onMessage = handler
          return worker as unknown as Worker
        },
        worldMinY: 0,
        worldHeight: 256,
        skyLightEnabled: true,
        onApplied: () => {}
      })
      onMessage({ type: 'ready' })
      posts.length = 0
      session.pushEvent(blockChangeEvent(8, 64, 8, 1))
      vi.runAllTimers()
      expect(posts.filter(message => message.type === 'step')).toHaveLength(1)
      posts.length = 0
      onMessage({ type: 'stepped', remaining: true, publication: null })
      vi.runAllTimers()
      expect(posts.filter(message => message.type === 'step')).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('selects only mesh workers that own dirty sections', () => {
    expect(
      meshWorkerIndexesForDirtySections(
        [
          { sx: 0, sy: 64, sz: 0 },
          { sx: 16, sy: 64, sz: 0 },
          { sx: 0, sy: 80, sz: 0 }
        ],
        8,
        (sx, _sy, sz) => ((sx / 16 + sz / 16) % 8 + 8) % 8
      ).sort((a, b) => a - b)
    ).toEqual([0, 1])
  })
})

describe('nether/end sky detection', () => {
  it('disables sky from lightingDisabled (nether/end / !hasSkyLight)', () => {
    expect(skyLightEnabledFromRendererState({ lightingDisabled: false })).toBe(true)
    expect(skyLightEnabledFromRendererState({ lightingDisabled: true })).toBe(false)
    expect(skyLightEnabledFromRendererState({})).toBe(true)
  })
})

describe('dirtyMeshSections stencil', () => {
  it('covers the 3x3x3 sample neighborhood, including the diagonal section', () => {
    const dirty = dirtyMeshSectionsFromChangedLight([{ sx: 0, sy: 64, sz: 0 }], { coords: 'world' })
    const keys = new Set(dirty.map(s => `${s.sx},${s.sy},${s.sz}`))
    expect(keys.has('0,64,0')).toBe(true)
    expect(keys.has('-16,64,0')).toBe(true)
    expect(keys.has('16,64,0')).toBe(true)
    expect(keys.has('0,48,0')).toBe(true)
    expect(keys.has('0,80,0')).toBe(true)
    expect(keys.has('0,64,-16')).toBe(true)
    expect(keys.has('0,64,16')).toBe(true)
    expect(keys.has('16,80,16')).toBe(true)
    expect(keys.size).toBe(27)
  })

  it('schedules geometry (16,16,16) when light (0,0,0) changes — west-face corner samples (15,15,15)', () => {
    const dirty = dirtyMeshSectionsFromChangedLight([{ sx: 0, sy: 0, sz: 0 }], { coords: 'world' })
    expect(dirty.some(s => s.sx === 16 && s.sy === 16 && s.sz === 16)).toBe(true)
  })

  it('converts engine section-index publications to world origins before expanding', () => {
    const dirty = dirtyMeshSectionsFromChangedLight([{ sx: 0, sy: 4, sz: 0 }], { coords: 'section-index' })
    expect(dirty.some(s => s.sx === 0 && s.sy === 64 && s.sz === 0)).toBe(true)
    expect(dirty.some(s => s.sx === 0 && s.sy === 80 && s.sz === 0)).toBe(true)
  })
})

describe('versioned mesh drop', () => {
  const gate: PublicationGate = { acceptedGeneration: 2, lastVersion: 5 }

  it('accepts geometry with no version (flag-off / pre-owner mesh path)', () => {
    expect(shouldAcceptMeshGeometry({}, gate)).toBe(true)
  })

  it('accepts a mesh of an independent section after an unrelated later publication', () => {
    expect(shouldAcceptMeshGeometry({ worldGeneration: 1, lightPublicationVersion: 1 }, { acceptedGeneration: 1, lastVersion: 2 })).toBe(true)
  })

  it('drops a mesh below the required revision of its own section', () => {
    const required = { requiredVersion: 5, worldGeneration: 2 }
    expect(shouldAcceptMeshGeometry({ worldGeneration: 1, lightPublicationVersion: 9 }, gate, required)).toBe(false)
    expect(shouldAcceptMeshGeometry({ worldGeneration: 2, lightPublicationVersion: 4 }, gate, required)).toBe(false)
  })

  it('accepts geometry stamped with the required publication of its section', () => {
    expect(shouldAcceptMeshGeometry({ worldGeneration: 2, lightPublicationVersion: 5 }, gate, { requiredVersion: 5, worldGeneration: 2 })).toBe(true)
  })
})

describe('packed nibble convert', () => {
  it('round-trips unpacked 4096 nibble-bytes through packed 2048', () => {
    const unpacked = unpackedSection(0)
    unpacked[0] = 7
    unpacked[1] = 14
    unpacked[256] = 3
    const packed = packUnpackedLightSection(unpacked)
    expect(packed).toHaveLength(2048)
    const back = unpackPackedLightSection(packed)
    expect(back[0]).toBe(7)
    expect(back[1]).toBe(14)
    expect(back[256]).toBe(3)
  })
})

describe('update_light → owner serverLight events', () => {
  it('emits omitted/empty/data independently for sky and block', () => {
    const skyLightMask = new Uint32Array(2)
    const emptySkyLightMask = new Uint32Array(2)
    const blockLightMask = new Uint32Array(2)
    const emptyBlockLightMask = new Uint32Array(2)
    maskBitSet(blockLightMask, worldSectionMaskBit(4))
    maskBitSet(emptyBlockLightMask, worldSectionMaskBit(0))
    maskBitSet(skyLightMask, worldSectionMaskBit(4))
    const blockLight = new Uint8Array(16 * 4096)
    blockLight.fill(9, 4 * 4096, 5 * 4096)
    const skyLight = new Uint8Array(16 * 4096)
    skyLight.fill(15, 4 * 4096, 5 * 4096)
    const parsed: ParsedUpdateLight = {
      x: 1,
      z: 2,
      trustEdges: true,
      numSections: 16,
      skyLight,
      blockLight,
      skyLightMask,
      emptySkyLightMask,
      blockLightMask,
      emptyBlockLightMask
    }
    const events = eventsFromParsedUpdateLight(parsed, 0)
    const blockData = events.find(e => e.type === 'serverLight' && e.channel === 'block' && e.sy === 4 && e.kind === 'data')
    const blockEmpty = events.find(e => e.type === 'serverLight' && e.channel === 'block' && e.sy === 0 && e.kind === 'empty')
    const skyData = events.find(e => e.type === 'serverLight' && e.channel === 'sky' && e.sy === 4 && e.kind === 'data')
    const omittedBlock = events.find(e => e.type === 'serverLight' && e.channel === 'block' && e.sy === 1)
    expect(blockData).toBeTruthy()
    expect(blockEmpty).toBeTruthy()
    expect(skyData).toBeTruthy()
    expect(omittedBlock).toBeUndefined()
    if (blockData?.type === 'serverLight' && blockData.kind === 'data') {
      expect(blockData.data).toHaveLength(2048)
      expect(blockData.sx).toBe(1)
      expect(blockData.sz).toBe(2)
    }
  })
})

describe('column load events', () => {
  it('ingests block sections from prismarine JSON as Loaded (main thread, not mesh workers)', () => {
    const mcData = MinecraftData(VERSION)
    const Chunk = Chunks(VERSION) as any
    const chunk = new Chunk()
    const torch = mcData.blocksByName.torch.defaultState
    chunk.setBlockStateId(new Vec3(8, 64, 8), torch)
    const events = eventsFromColumnLoad({
      chunkX: 0,
      chunkZ: 16,
      chunkJson: chunk.toJson(),
      version: VERSION,
      worldMinY: 0,
      worldHeight: 256
    })
    const ingest = events.filter(e => e.type === 'ingestBlockSection')
    const loaded = events.filter(e => e.type === 'setAvailability' && e.availability === 'loaded')
    expect(ingest.length).toBeGreaterThan(0)
    expect(loaded.length).toBe(ingest.length)
    const section4 = ingest.find(e => e.type === 'ingestBlockSection' && e.sy === 4 && e.sz === 1)
    expect(section4?.type === 'ingestBlockSection' && section4.states[8 + 8 * 16 + 0 * 256]).toBe(torch)
    expect(blockChangeEvent(8, 64, 8, 0)).toEqual({ type: 'blockChange', x: 8, y: 64, z: 8, stateId: 0 })
    expect(eventsFromColumnUnload(32, 48)).toEqual({ type: 'unloadColumn', sx: 2, sz: 3 })
  })

  it('does not call getBlockStateId 4096 times per section when section data exists', () => {
    const mcData = MinecraftData(VERSION)
    const Chunk = Chunks(VERSION) as any
    const chunk = new Chunk()
    const torch = mcData.blocksByName.torch.defaultState
    const stone = mcData.blocksByName.stone.defaultState
    chunk.setBlockStateId(new Vec3(8, 64, 8), torch)
    chunk.setBlockStateId(new Vec3(3, 20, 3), stone)
    let calls = 0
    const original = chunk.getBlockStateId.bind(chunk)
    chunk.getBlockStateId = (pos: Vec3) => {
      calls++
      return original(pos)
    }
    const events = eventsFromColumnLoad({
      chunkX: 0,
      chunkZ: 0,
      chunkJson: chunk,
      version: VERSION,
      worldMinY: 0,
      worldHeight: 256
    })
    expect(calls).toBe(0)
    const ingest = events.filter(e => e.type === 'ingestBlockSection')
    const section4 = ingest.find(e => e.type === 'ingestBlockSection' && e.sy === 4)
    const section1 = ingest.find(e => e.type === 'ingestBlockSection' && e.sy === 1)
    expect(section4?.type === 'ingestBlockSection' && section4.states[8 + 8 * 16 + 0 * 256]).toBe(torch)
    expect(section1?.type === 'ingestBlockSection' && section1.states[3 + 3 * 16 + 4 * 256]).toBe(stone)
  })
})

describe('apply publication → cache + dirty mesh + worker fan-out', () => {
  it('writes packed channels directly and reports dirtyMeshSections plus a worker message', () => {
    const cache = new RendererLightCache(VERSION)
    cache.setWorldBounds(0, 256)
    const pub: LightPublication = {
      worldGeneration: 1,
      publicationVersion: 3,
      sections: [{ sx: 0, sy: 4, sz: 0, blockLight: packedNibble(9), skyLight: packedNibble(2) }]
    }
    const result = applyOwnerPublicationToRenderer(cache, pub, { acceptedGeneration: 1, lastVersion: 0 }, 'section-index')
    expect(result.applied).toBe(true)
    expect(result.lastVersion).toBe(3)
    expect(cache.getLight(0, 64, 0).block).toBeCloseTo(11 / 15, 5)
    expect(cache.getLight(0, 64, 0).sky).toBeCloseTo(4 / 15, 5)
    expect(result.dirtyMeshSections.some(s => s.sx === 0 && s.sy === 64 && s.sz === 0)).toBe(true)
    expect(result.dirtyMeshSections.some(s => s.sx === 16 && s.sy === 64 && s.sz === 0)).toBe(true)
    expect(result.workerMessage?.type).toBe('applyOwnerLightPublication')
    expect(result.workerMessage?.publicationVersion).toBe(3)
    expect(result.workerMessage?.sections[0]?.blockLight).toHaveLength(2048)
  })
})

describe('flag-on in-process host: load / setBlock / unload → publication → cache', () => {
  it('ingests a torch place and then air through the owner ABI', async () => {
    const cache = new RendererLightCache(VERSION)
    cache.setWorldBounds(0, 256)
    const host = await LightOwnerHost.createInProcess(cache, { worldMinY: 0, worldHeight: 256 })
    host.setLightTables({
      emission: Uint8Array.of(0, 0, 14),
      opacity: Uint8Array.of(0, 15, 0)
    })
    for (const event of eventsFromColumnLoad({
      chunkX: 0,
      chunkZ: 0,
      chunkJson: makeAirColumnJson(),
      version: VERSION,
      worldMinY: 0,
      worldHeight: 256
    })) {
      if ('sy' in event && event.sy !== 4) continue
      host.pushEvent(event)
    }
    host.pushEvent(blockChangeEvent(8, 64, 8, 2))
    const placed = await host.stepUntilIdle(64)
    expect(placed?.publicationVersion).toBeGreaterThan(0)
    expect(cache.getLight(8, 64, 8).block).toBeGreaterThan(0.5)
    host.pushEvent(blockChangeEvent(8, 64, 8, 0))
    await host.stepUntilIdle(32)
    expect(cache.getLight(8, 64, 8).block).toBeCloseTo(2 / 15, 5)
    host.pushEvent(eventsFromColumnUnload(0, 0))
    await host.stepUntilIdle(16)
  })
})
