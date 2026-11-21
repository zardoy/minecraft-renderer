import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Vec3 } from 'vec3'
import { WorldView } from './worldView'

const createView = (viewDistance: number) => {
  const columns = new Set<string>()
  const column = { toJson: () => '{}', minY: 0, worldHeight: 256, blockEntities: {} }
  const world = {
    getColumnAt: (pos: Vec3) => (columns.has(`${pos.x},${pos.z}`) ? column : null),
    setBlockStateId: vi.fn()
  }
  const view = new WorldView(world, viewDistance, new Vec3(8, 64, 8))
  const emitted: string[] = []
  view.on('loadChunk', ({ x, z }) => emitted.push(`${x / 16},${z / 16}`))
  /** what a client does when the server sends a column */
  const serverSends = (cx: number, cz: number) => {
    columns.add(`${cx * 16},${cz * 16}`)
    view.columnArrived({ x: cx * 16, z: cz * 16 })
  }
  return { view, emitted, serverSends }
}

describe('WorldView gives columns to the renderer nearest first', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a server sending row by row still gets the player column first', async () => {
    const { view, emitted, serverSends } = createView(2)
    void view.init(new Vec3(8, 64, 8))
    for (let cz = -2; cz <= 2; cz++) for (let cx = -2; cx <= 2; cx++) serverSends(cx, cz)
    await vi.runAllTimersAsync()
    expect(emitted).toHaveLength(25)
    expect(emitted[0]).toBe('0,0')
    expect(emitted.slice(1, 5).sort()).toEqual(['-1,0', '0,-1', '0,1', '1,0'])
    expect(emitted.slice(-4).sort()).toEqual(['-2,-2', '-2,2', '2,-2', '2,2'])
  })

  it('loadChunk for a column the renderer does not have yet does not jump the queue', async () => {
    const { view, emitted, serverSends } = createView(1)
    void view.init(new Vec3(8, 64, 8))
    serverSends(1, 1)
    // the old client path for any column the spiral was not waiting on
    await view.loadChunk({ x: 16, z: 16 }, false, 'chunkColumnLoad')
    await vi.advanceTimersByTimeAsync(100)
    expect(emitted).toEqual([])

    serverSends(0, 0)
    await vi.advanceTimersByTimeAsync(10)
    expect(emitted).toEqual(['0,0'])
  })

  it('a column the server never sends holds the rest back only for a moment', async () => {
    const { view, emitted, serverSends } = createView(1)
    void view.init(new Vec3(8, 64, 8))
    serverSends(1, 0)
    await vi.advanceTimersByTimeAsync(100)
    expect(emitted).toEqual([])
    await vi.advanceTimersByTimeAsync(1500)
    expect(emitted).toEqual(['1,0'])
  })

  it('moving recenters the order on the new chunk', async () => {
    const { view, emitted, serverSends } = createView(1)
    void view.init(new Vec3(8, 64, 8))
    await view.updatePosition(new Vec3(5 * 16 + 8, 64, 8))
    serverSends(6, 1)
    serverSends(5, 0)
    await vi.runAllTimersAsync()
    expect(emitted).toEqual(['5,0', '6,1'])
  })
})
