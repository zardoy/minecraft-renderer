import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Vec3 } from 'vec3'
import { WorldView } from './worldView'

const createView = () => {
  const world = {
    getColumnAt: () => null,
    setBlockStateId: vi.fn()
  }
  const view = new WorldView(world, 8, new Vec3(0, 64, 0))
  const loadChunk = vi.fn(async () => true)
  view.loadChunk = loadChunk
  return { view, loadChunk }
}

describe('WorldView.queueLightRemesh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reloads each column at most once per frame', () => {
    const { view, loadChunk } = createView()
    view.loadedChunks['0,0'] = true
    view.loadedChunks['16,0'] = true

    view.queueLightRemesh(0, 0)
    view.queueLightRemesh(0, 0)
    view.queueLightRemesh(16, 0)
    view.queueLightRemesh(0, 0)
    expect(loadChunk).not.toHaveBeenCalled()

    vi.runAllTimers()
    expect(loadChunk).toHaveBeenCalledTimes(2)
    expect(loadChunk).toHaveBeenCalledWith({ x: 0, z: 0 }, true, 'update_light')
    expect(loadChunk).toHaveBeenCalledWith({ x: 16, z: 0 }, true, 'update_light')

    view.queueLightRemesh(0, 0)
    vi.runAllTimers()
    expect(loadChunk).toHaveBeenCalledTimes(3)
  })

  it('does not resurrect a column unloaded before the flush', () => {
    const { view, loadChunk } = createView()
    view.loadedChunks['0,0'] = true

    view.queueLightRemesh(0, 0)
    view.unloadChunk({ x: 0, z: 0 })
    vi.runAllTimers()

    expect(loadChunk).not.toHaveBeenCalled()
    expect(view.loadedChunks['0,0']).toBeUndefined()
  })

  it('skips columns that are not loaded or still waiting for the spiral', () => {
    const { view, loadChunk } = createView()
    view.loadedChunks['16,0'] = true
    view.waitingSpiralChunksLoad['16,0'] = () => {}

    view.queueLightRemesh(0, 0)
    view.queueLightRemesh(16, 0)
    vi.runAllTimers()

    expect(loadChunk).not.toHaveBeenCalled()
  })

  it('drops queued reloads on end', () => {
    const { view, loadChunk } = createView()
    view.loadedChunks['0,0'] = true

    view.queueLightRemesh(0, 0)
    view.emit('end')
    vi.runAllTimers()

    expect(loadChunk).not.toHaveBeenCalled()
  })
})
