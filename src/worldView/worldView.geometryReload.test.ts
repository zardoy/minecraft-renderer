import { describe, expect, it, vi } from 'vitest'
import { WorldView } from './worldView'

const column = () => ({ toJson: () => '{}', minY: 0, worldHeight: 256 })
function setup(getColumnAt = vi.fn(async () => column())) {
  const view = new WorldView({ getColumnAt, setBlockStateId: vi.fn() }, 4)
  view.loadedChunks = { '0,0': true, '16,0': true }
  return { view, getColumnAt }
}

describe('geometry-only column reload', () => {
  it('retains membership and requests light preservation', async () => {
    const { view } = setup()
    const unload = vi.fn()
    const load = vi.fn()
    view.on('unloadChunk', unload)
    view.on('loadChunk', load)
    await view.reloadColumnGeometry()
    expect(view.loadedChunks).toEqual({ '0,0': true, '16,0': true })
    expect(unload.mock.calls.map(([data]) => data)).toEqual([
      { x: 0, z: 0, preserveClientLight: true },
      { x: 16, z: 0, preserveClientLight: true }
    ])
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('does not resurrect a column unloaded during an asynchronous fetch', async () => {
    let resolve!: (value: ReturnType<typeof column>) => void
    const pending = new Promise<ReturnType<typeof column>>(r => { resolve = r })
    const { view } = setup(vi.fn(() => pending))
    view.loadedChunks = { '0,0': true }
    const load = vi.fn()
    view.on('loadChunk', load)
    const reload = view.reloadColumnGeometry()
    expect(view.reloadColumnGeometry()).toBe(reload)
    view.unloadChunk({ x: 0, z: 0 })
    resolve(column())
    await reload
    expect(load).not.toHaveBeenCalled()
    expect(view.loadedChunks['0,0']).toBeUndefined()
  })

  it('cleans up failed columns and continues loading the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const get = vi.fn().mockRejectedValueOnce(new Error('fetch failed')).mockResolvedValue(column())
      const { view } = setup(get)
      const load = vi.fn()
      view.on('loadChunk', load)
      await view.reloadColumnGeometry()
      expect(view.loadedChunks).toEqual({ '16,0': true })
      expect(load).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })

  it('truly unloads columns outside the current range or missing from the world', async () => {
    const { view } = setup(vi.fn(async () => null) as any)
    view.loadedChunks['160,0'] = true
    await view.reloadColumnGeometry()
    expect(view.loadedChunks).toEqual({})
  })
})
