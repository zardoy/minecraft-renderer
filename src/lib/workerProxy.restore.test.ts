import { describe, expect, it } from 'vitest'
import { restoreTransferred } from './workerProxy'

describe('restoreTransferred Set/Map', () => {
  const worker = null as unknown as Worker

  it('restores Set from __setValues', () => {
    const out = restoreTransferred({ __restorer: 'Set', __setValues: ['a', 'b'] }, [], worker, false)
    expect(out).toEqual(new Set(['a', 'b']))
  })

  it('does not throw when legacy values is a function (Map.values collision)', () => {
    const map = new Map([['k', 1]])
    const out = restoreTransferred({ __restorer: 'Set', values: map.values.bind(map) }, [], worker, false)
    expect(out).toEqual(new Set())
  })

  it('restores Map from __mapEntries', () => {
    const out = restoreTransferred({ __restorer: 'Map', __mapEntries: [['a', 1]] }, [], worker, false)
    expect(out).toEqual(new Map([['a', 1]]))
  })

  it('does not throw when legacy entries is a function', () => {
    const m = new Map()
    const out = restoreTransferred({ __restorer: 'Map', entries: m.entries.bind(m) }, [], worker, false)
    expect(out).toEqual(new Map())
  })
})
