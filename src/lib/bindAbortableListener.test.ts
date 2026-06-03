import { EventEmitter } from 'events'
import { describe, expect, it } from 'vitest'
import { bindAbortableEmitterListener, bindAbortableListener } from './bindAbortableListener'
import { WorldViewWorker } from '../worldView'

describe('bindAbortableListener', () => {
  it('removes handler on abort', () => {
    const emitter = new WorldViewWorker()
    const controller = new AbortController()
    let calls = 0
    bindAbortableListener(emitter, 'renderDistance', () => {
      calls++
    }, controller.signal)

    emitter.emit('renderDistance', 8)
    expect(calls).toBe(1)

    controller.abort()
    emitter.emit('renderDistance', 12)
    expect(calls).toBe(1)
  })

  it('abort removes only the bound handler on a shared emitter', () => {
    const emitter = new WorldViewWorker()
    const controllerA = new AbortController()
    const controllerB = new AbortController()
    let callsA = 0
    let callsB = 0

    bindAbortableListener(emitter, 'renderDistance', () => {
      callsA++
    }, controllerA.signal)
    bindAbortableListener(emitter, 'renderDistance', () => {
      callsB++
    }, controllerB.signal)

    emitter.emit('renderDistance', 4)
    expect(callsA).toBe(1)
    expect(callsB).toBe(1)

    controllerA.abort()
    emitter.emit('renderDistance', 6)
    expect(callsA).toBe(1)
    expect(callsB).toBe(2)
  })
})

describe('bindAbortableEmitterListener', () => {
  it('removes handler on abort', () => {
    const emitter = new EventEmitter()
    const controller = new AbortController()
    let calls = 0
    bindAbortableEmitterListener(emitter, 'test', () => {
      calls++
    }, controller.signal)

    emitter.emit('test')
    expect(calls).toBe(1)

    controller.abort()
    emitter.emit('test')
    expect(calls).toBe(1)
  })
})
