import { describe, expect, it } from 'vitest'
import { ColumnLoadQueue, type ColumnLoadStep } from './columnLoadQueue'

const key = (cx: number, cz: number) => `${cx * 16},${cz * 16}`

/** Drive the queue like `WorldView` does: give out every column it emits until it waits or idles. */
const drain = (queue: ColumnLoadQueue, received: Set<string>, loaded: Set<string>, now: number) => {
  const order: string[] = []
  let step: ColumnLoadStep
  for (;;) {
    step = queue.next(
      now,
      column => received.has(column.key),
      k => loaded.has(k)
    )
    if (step.kind !== 'emit') break
    loaded.add(step.key)
    order.push(step.key)
  }
  return { order, step }
}

describe('ColumnLoadQueue', () => {
  it('gives columns out nearest first whatever order they arrived in', () => {
    const queue = new ColumnLoadQueue(500)
    queue.setCenter(0, 0, 2, 0)
    const received = new Set<string>()
    const loaded = new Set<string>()
    // a server sending row by row: the far corner first
    for (let cz = -2; cz <= 2; cz++) for (let cx = -2; cx <= 2; cx++) received.add(key(cx, cz))
    const { order, step } = drain(queue, received, loaded, 0)
    expect(step.kind).toBe('done')
    expect(order).toHaveLength(25)
    const distance = (k: string) => {
      const [x, z] = k.split(',').map(Number)
      return (x! / 16) ** 2 + (z! / 16) ** 2
    }
    for (let i = 1; i < order.length; i++) expect(distance(order[i]!)).toBeGreaterThanOrEqual(distance(order[i - 1]!))
    expect(order[0]).toBe(key(0, 0))
  })

  it('a far column waits while a nearer one has not arrived, then the nearer one goes first', () => {
    const queue = new ColumnLoadQueue(500)
    queue.setCenter(0, 0, 2, 0)
    const received = new Set([key(2, 2)])
    const loaded = new Set<string>()
    let result = drain(queue, received, loaded, 0)
    expect(result.order).toEqual([])
    expect(result.step).toMatchObject({ kind: 'wait', at: 500, front: { key: key(0, 0) } })

    received.add(key(0, 0))
    result = drain(queue, received, loaded, 100)
    expect(result.order).toEqual([key(0, 0)])
    expect(result.step.kind).toBe('wait')
  })

  it('passes a missing column over after the stall time; it goes first once it arrives', () => {
    const queue = new ColumnLoadQueue(500)
    queue.setCenter(0, 0, 1, 0)
    const received = new Set<string>()
    const loaded = new Set<string>()
    for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) if (cx !== 0 || cz !== 0) received.add(key(cx, cz))
    expect(drain(queue, received, loaded, 0).step.kind).toBe('wait')
    const late = drain(queue, received, loaded, 500)
    expect(late.order).toHaveLength(8)
    expect(late.step.kind).toBe('done')

    received.add(key(0, 0))
    expect(drain(queue, received, loaded, 600).order).toEqual([key(0, 0)])
  })

  it('several missing columns do not add their waits up', () => {
    const queue = new ColumnLoadQueue(500)
    queue.setCenter(0, 0, 2, 0)
    const received = new Set<string>()
    for (let cz = -2; cz <= 2; cz++) for (let cx = -2; cx <= 2; cx++) received.add(key(cx, cz))
    received.delete(key(0, 0))
    received.delete(key(1, 0))
    const loaded = new Set<string>()
    expect(drain(queue, received, loaded, 0).step.kind).toBe('wait')
    const result = drain(queue, received, loaded, 500)
    expect(result.order).toHaveLength(23)
    expect(result.step.kind).toBe('done')
  })

  it('a column that arrives late is held for the full stall time from its own arrival', () => {
    const queue = new ColumnLoadQueue(500)
    queue.setCenter(0, 0, 1, 0)
    const received = new Set([key(1, 1)])
    queue.arrived(key(1, 1), 400)
    expect(drain(queue, received, new Set(), 600).step).toMatchObject({ kind: 'wait', at: 900 })
  })

  it('keeps waiting for a near column while the server is still sending others, up to maxHoldMs', () => {
    const queue = new ColumnLoadQueue(500, 5000)
    queue.setCenter(0, 0, 3, 0)
    const received = new Set<string>()
    const loaded = new Set<string>()
    // a slow client: the far row arrives first, then one column every 300 ms, the player column never
    received.add(key(3, 3))
    queue.arrived(key(3, 3), 0)
    let now = 0
    for (let i = 0; i < 10; i++) {
      now += 300
      const k = key(-3, i - 3 > 3 ? 3 : i - 3)
      received.add(k)
      queue.arrived(k, now)
      expect(drain(queue, received, loaded, now).order).toEqual([])
    }
    // the far column has waited 5 s: given out even though columns are still arriving
    expect(drain(queue, received, loaded, 5000).order.length).toBeGreaterThan(0)
  })

  it('never gives up on a column while nothing else is ready to show', () => {
    const queue = new ColumnLoadQueue(500)
    queue.setCenter(0, 0, 1, 0)
    const step = drain(queue, new Set(), new Set(), 60_000).step
    expect(step).toMatchObject({ kind: 'idle', front: { key: key(0, 0) } })
  })

  it('does not offer a column the renderer could not take until it arrives again', () => {
    const queue = new ColumnLoadQueue(500)
    queue.setCenter(0, 0, 0, 0)
    const received = new Set([key(0, 0)])
    const first = queue.next(
      0,
      column => received.has(column.key),
      () => false
    )
    expect(first.kind).toBe('emit')
    queue.reject(key(0, 0))
    expect(
      queue.next(
        0,
        column => received.has(column.key),
        () => false
      ).kind
    ).toBe('done')
    queue.arrived(key(0, 0), 0)
    expect(
      queue.next(
        0,
        column => received.has(column.key),
        () => false
      ).kind
    ).toBe('emit')
  })
})
