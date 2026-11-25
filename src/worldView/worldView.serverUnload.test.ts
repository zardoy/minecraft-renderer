import { describe, expect, it, vi } from 'vitest'
import { Vec3 } from 'vec3'
import { WorldView } from './worldView'

/** Player in chunk 0,0, view distance 8, one ring kept beyond it. */
const createView = (keepChunksDistance = 1) => {
  const world = { getColumnAt: () => null, setBlockStateId: vi.fn() }
  const view = new WorldView(world, 8, new Vec3(8, 64, 8))
  view.keepChunksDistance = keepChunksDistance
  const unloads: string[] = []
  view.on('unloadChunk', ({ x, z }) => unloads.push(`${x},${z}`))
  return { view, unloads }
}

describe('WorldView.columnUnloadedByServer', () => {
  it('keeps showing a column the server unloads at the edge of the view', () => {
    const { view, unloads } = createView()
    view.loadedChunks['128,0'] = true // chunk 8: the edge

    view.columnUnloadedByServer({ x: 128, z: 0 })

    expect(unloads).toEqual([])
    expect(view.loadedChunks['128,0']).toBe(true)
  })

  it('drops it once the player moves farther away, keeps it when the player comes back', async () => {
    const { view, unloads } = createView()
    view.loadedChunks['128,0'] = true
    view.loadedChunks['-128,0'] = true
    view.columnUnloadedByServer({ x: 128, z: 0 })
    view.columnUnloadedByServer({ x: -128, z: 0 })

    // one chunk towards -x: 128,0 is now 9 chunks away (farther), -128,0 is 7 (nearer, the server sends it again)
    await view.updatePosition(new Vec3(-8, 64, 8))

    expect(unloads).toEqual(['128,0'])
    expect(view.loadedChunks['128,0']).toBeUndefined()
    expect(view.loadedChunks['-128,0']).toBe(true)
  })

  it('a column sent again is no longer pending removal', async () => {
    const { view, unloads } = createView()
    view.loadedChunks['128,0'] = true
    view.columnUnloadedByServer({ x: 128, z: 0 })
    view.columnArrived({ x: 128, z: 0 })

    await view.updatePosition(new Vec3(-8, 64, 8))

    // 9 chunks away is still within the kept ring: the normal rule keeps it
    expect(unloads).toEqual([])
  })

  it('unloads at once without the kept ring or for the column the player is in', () => {
    const off = createView(0)
    off.view.loadedChunks['128,0'] = true
    off.view.columnUnloadedByServer({ x: 128, z: 0 })
    expect(off.unloads).toEqual(['128,0'])

    const own = createView()
    own.view.loadedChunks['0,0'] = true
    own.view.columnUnloadedByServer({ x: 0, z: 0 })
    expect(own.unloads).toEqual(['0,0'])
  })

  it('a forced position update drops every column the server unloaded', async () => {
    const { view, unloads } = createView()
    view.loadedChunks['128,0'] = true
    view.columnUnloadedByServer({ x: 128, z: 0 })

    await view.updatePosition(new Vec3(8, 64, 8), true)

    expect(unloads).toEqual(['128,0'])
  })
})
