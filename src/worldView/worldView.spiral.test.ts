import { describe, expect, it, vi } from 'vitest'
import { Vec3 } from 'vec3'
import { WorldView } from './worldView'

describe('WorldView._loadChunks spiral guard', () => {
  it('does not let a superseded spiral reset inLoading or panic state', async () => {
    const world = {
      getColumnAt: () => null,
      setBlockStateId: vi.fn(),
    }
    const view = new WorldView(world, 8, new Vec3(0, 64, 0))
    view.addWaitTime = 0
    view.loadChunk = vi.fn(async () => {})

    const positions = [new Vec3(0, 0, 0)]
    const spiralA = view._loadChunks(positions, new Vec3(0, 64, 0))
    await Promise.resolve()

    expect(view.inLoading).toBe(true)
    expect(view.spiralNumber).toBe(1)

    const spiralB = view._loadChunks(positions, new Vec3(0, 64, 0))
    await Promise.resolve()

    expect(view.spiralNumber).toBe(2)
    expect(view.inLoading).toBe(true)
    expect(view.gotPanicLastTime).toBe(false)

    await spiralA
    expect(view.inLoading).toBe(true)
    expect(view.gotPanicLastTime).toBe(false)

    view.waitingSpiralChunksLoad['0,0']?.(true)
    await spiralB
    expect(view.inLoading).toBe(false)
  })
})
