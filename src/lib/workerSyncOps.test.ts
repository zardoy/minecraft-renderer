import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { proxy, subscribe } from 'valtio'
import { Vec3 } from 'vec3'
import {
  applySyncOps,
  getWorkerSyncStatsForTest,
  resetWorkerSyncStatsForTest,
  sendWorkerSyncOps,
  setByPath,
  type WireSyncOp,
} from './workerProxy'
import { defaultPerformanceInstabilityFactors } from '../performanceMonitor'

const fakeWorker = () => {
  const listeners: Array<(event: { data: any }) => void> = []
  return {
    postMessage: vi.fn((data: any) => {
      for (const listener of listeners) {
        listener({ data })
      }
    }),
    addEventListener: vi.fn((_type: string, listener: (event: { data: any }) => void) => {
      listeners.push(listener)
    }),
    removeEventListener: vi.fn(),
  } as unknown as Worker
}

const makeRendererState = () => proxy({
  world: {
    chunksLoaded: {} as Record<string, true>,
    heightmaps: {} as Record<string, Int16Array>,
    allChunksLoaded: false,
    mesherWork: false,
    instabilityFactors: defaultPerformanceInstabilityFactors(),
    intersectMedia: null as null | object,
  },
  renderer: '...',
  preventEscapeMenu: false,
})

describe('workerSyncOps', () => {
  it('set op round-trips mesherWork', () => {
    const source = makeRendererState()
    const target = makeRendererState()
    const ops: WireSyncOp[] = [{ kind: 'set', path: ['world', 'mesherWork'], value: true }]
    applySyncOps(target, ops, fakeWorker())
    expect(target.world.mesherWork).toBe(true)
    expect(source.world.mesherWork).toBe(false)
  })

  it('top-level set round-trips renderer', () => {
    const target = makeRendererState()
    applySyncOps(target, [{ kind: 'set', path: ['renderer'], value: 'WebGL2 r123' }], fakeWorker())
    expect(target.renderer).toBe('WebGL2 r123')
  })

  it('nested set creates chunksLoaded key on receiver', () => {
    const target = makeRendererState()
    applySyncOps(target, [{ kind: 'set', path: ['world', 'chunksLoaded', '1,2'], value: true }], fakeWorker())
    expect(target.world.chunksLoaded['1,2']).toBe(true)
  })

  it('delete op removes heightmap key on receiver', () => {
    const target = makeRendererState()
    target.world.heightmaps['1,2'] = new Int16Array(256)
    applySyncOps(target, [{ kind: 'delete', path: ['world', 'heightmaps', '1,2'] }], fakeWorker())
    expect(target.world.heightmaps['1,2']).toBeUndefined()
  })

  it('Int16Array value survives copy without neutering sender buffer', () => {
    const source = new Int16Array([1, 2, 3])
    const sender = makeRendererState()
    sender.world.heightmaps['0,0'] = source
    const receiver = makeRendererState()
    const buf = sender.world.heightmaps['0,0']!
    applySyncOps(receiver, [{
      kind: 'set',
      path: ['world', 'heightmaps', '0,0'],
      value: new Int16Array(buf),
    }], fakeWorker())
    expect([...receiver.world.heightmaps['0,0']!]).toEqual([1, 2, 3])
    expect(sender.world.heightmaps['0,0']![0]).toBe(1)
  })

  it('Vec3 value survives via restorer', () => {
    const target = makeRendererState() as any
    const vec = new Vec3(1, 2, 3)
    applySyncOps(target, [{
      kind: 'set',
      path: ['world', 'intersectMedia'],
      value: { pos: { x: 1, y: 2, z: 3, __restorer: 'Vec3' } },
    }], fakeWorker())
    expect(target.world.intersectMedia.pos).toBeInstanceOf(Vec3)
    expect(target.world.intersectMedia.pos.x).toBe(1)
  })

  it('batched ops in one tick produce one message with multiple ops', async () => {
    const worker = fakeWorker()
    const syncId = 'test-sync'
    const source = makeRendererState()
    let messageCount = 0
    ;(worker.postMessage as ReturnType<typeof vi.fn>).mockImplementation((data: any) => {
      messageCount++
      expect(data.ops.length).toBeGreaterThanOrEqual(2)
    })
    await new Promise<void>((resolve) => {
      subscribe(source, (ops) => {
        sendWorkerSyncOps(syncId, ops, worker, 'toWorker', 'test')
        resolve()
      })
      source.world.mesherWork = true
      source.renderer = 'batch'
    })
    expect(messageCount).toBe(1)
  })

  describe('debugWorkerSyncStats', () => {
    beforeEach(() => {
      resetWorkerSyncStatsForTest()
    })

    afterEach(() => {
      resetWorkerSyncStatsForTest()
      vi.useRealTimers()
    })

    it('one postMessage increments toWorker by 1 regardless of op count', () => {
      const worker = fakeWorker()
      sendWorkerSyncOps('id', [
        ['set', ['world', 'mesherWork'], true, false],
        ['set', ['renderer'], 'x', '...'],
      ], worker, 'toWorker', 'test')
      expect(worker.postMessage).toHaveBeenCalledTimes(1)
      expect(getWorkerSyncStatsForTest().toWorker).toBe(1)
    })

    it('applySyncOps with fromWorker counts one receive per message', () => {
      const target = makeRendererState()
      applySyncOps(target, [
        { kind: 'set', path: ['world', 'mesherWork'], value: true },
        { kind: 'set', path: ['renderer'], value: 'y' },
      ], fakeWorker(), 'fromWorker')
      expect(getWorkerSyncStatsForTest().fromWorker).toBe(1)
    })
  })

  it('setByPath handles length-1 path', () => {
    const target = { renderer: 'old' }
    setByPath(target, ['renderer'], 'new')
    expect(target.renderer).toBe('new')
  })
})
