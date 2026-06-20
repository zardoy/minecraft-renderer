import { describe, expect, it, vi } from 'vitest'
import { WorldViewWorker } from './worldView'

describe('WorldViewWorker.restoreTransferred bridge', () => {
  it('registers only one message listener per worker across restores', () => {
    const addSpy = vi.fn()
    const worker = {
      addEventListener: addSpy,
      removeEventListener: vi.fn()
    } as unknown as Worker

    WorldViewWorker.restoreTransferred({}, worker)
    WorldViewWorker.restoreTransferred({}, worker)
    WorldViewWorker.restoreTransferred({}, worker)

    expect(addSpy).toHaveBeenCalledTimes(1)
    expect(WorldViewWorker.getWorkerBridgeListenerCountForTest(worker)).toBe(1)

    WorldViewWorker.clearWorkerBridgeForTest(worker)
  })

  it('routes events to the latest restored worldView only', () => {
    const listeners: Array<(event: MessageEvent) => void> = []
    const worker = {
      addEventListener: (_type: string, handler: (event: MessageEvent) => void) => {
        listeners.push(handler)
      },
      removeEventListener: () => {}
    } as unknown as Worker

    const first = WorldViewWorker.restoreTransferred({}, worker)
    const second = WorldViewWorker.restoreTransferred({}, worker)

    let firstCalls = 0
    let secondCalls = 0
    first.on('loadChunk', () => {
      firstCalls++
    })
    second.on('loadChunk', () => {
      secondCalls++
    })

    const handler = listeners[0]!
    handler({
      data: {
        class: WorldViewWorker.restorerName,
        type: 'event',
        eventName: 'loadChunk',
        args: [{ x: 0, z: 0, chunk: {}, worldConfig: {}, isLightUpdate: false }]
      }
    } as MessageEvent)

    expect(firstCalls).toBe(0)
    expect(secondCalls).toBe(1)

    WorldViewWorker.clearWorkerBridgeForTest(worker)
  })
})
