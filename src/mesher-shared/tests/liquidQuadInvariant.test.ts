import { test, expect } from 'vitest'
import { setup } from '../../mesher-legacy/test/mesherTester'

test('renderLiquid blend output satisfies 6/4 quad invariant with both windings', () => {
  const { getGeometry } = setup(
    '1.16.5',
    [
      [[0, 0, 0], 'water'],
      [[0, -1, 0], 'stone'],
      [[1, 0, 0], 'stone'],
      [[-1, 0, 0], 'stone'],
      [[0, 0, 1], 'stone'],
      [[0, 0, -1], 'stone']
    ],
    { noDebugTiles: true }
  )

  const { attr } = getGeometry()
  const blend = attr.blend
  expect(blend).toBeDefined()
  expect(blend!.positions.length).toBeGreaterThan(0)

  const quadCount = blend!.positions.length / 3 / 4
  expect(blend!.indices.length / 6).toBe(quadCount)

  for (let i = 0; i < blend!.indices.length; i += 12) {
    const b = blend!.indices[i]!
    const d = blend!.indices[i + 6]!
    expect(blend!.indices[i]).toBe(b)
    expect(blend!.indices[i + 1]).toBe(b + 1)
    expect(blend!.indices[i + 2]).toBe(b + 2)
    expect(blend!.indices[i + 3]).toBe(b + 2)
    expect(blend!.indices[i + 4]).toBe(b + 1)
    expect(blend!.indices[i + 5]).toBe(b + 3)
    expect(blend!.indices[i + 6]).toBe(d)
    expect(blend!.indices[i + 7]).toBe(d + 2)
    expect(blend!.indices[i + 8]).toBe(d + 1)
    expect(blend!.indices[i + 9]).toBe(d + 1)
    expect(blend!.indices[i + 10]).toBe(d + 2)
    expect(blend!.indices[i + 11]).toBe(d + 3)
    expect(d).toBe(b + 4)
  }
})
