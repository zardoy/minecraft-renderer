import { describe, expect, test } from 'vitest'
import { BULK_COLUMNS_PER_TICK, selectColumnGroupsForTick } from '../worker/mesherWasmColumnTickSelect'

function dirtyOf(keys: string[]): Map<string, number> {
  const dirty = new Map<string, number>()
  for (const key of keys) dirty.set(key, 1)
  return dirty
}

describe('selectColumnGroupsForTick', () => {
  test('viewer selects the four nearest bulk columns, leaving the farthest', () => {
    const dirty = dirtyOf(['160,64,0', '64,64,0', '0,64,0', '16,64,16', '-32,64,0', '48,64,0'])
    const { selected, remaining } = selectColumnGroupsForTick(dirty, new Set(), 4, { x: 0, z: 0 })
    expect(selected.map(group => `${group.x},${group.z}`)).toEqual(['0,0', '16,16', '-32,0', '48,0'])
    expect([...remaining.keys()]).toEqual(['64,64,0', '160,64,0'])
  })

  test('equal viewer distances keep insertion order', () => {
    const dirty = dirtyOf(['16,64,0', '0,64,-16', '-16,64,0', '0,64,16'])
    const { selected } = selectColumnGroupsForTick(dirty, new Set(), 2, { x: 0, z: 0 })
    expect(selected.map(group => `${group.x},${group.z}`)).toEqual(['16,0', '0,-16'])
  })

  test('viewer leaves urgent columns first, uncapped and in insertion order', () => {
    const dirty = dirtyOf(['160,64,0', '0,64,0', '320,64,0', '16,64,0'])
    const { selected, remaining } = selectColumnGroupsForTick(dirty, new Set(['160,64,0', '320,64,0']), 1, { x: 0, z: 0 })
    expect(selected.map(group => `${group.x},${group.z}`)).toEqual(['160,0', '320,0', '0,0'])
    expect([...remaining.keys()]).toEqual(['16,64,0'])
  })

  test('urgent columns are selected before bulk columns', () => {
    const dirty = dirtyOf(['160,64,0', '0,64,0', '32,64,0'])
    const urgent = new Set(['0,64,0'])
    const { selected, remaining } = selectColumnGroupsForTick(dirty, urgent, 4)
    expect(selected.map(group => `${group.x},${group.z}`)).toEqual(['0,0', '160,0', '32,0'])
    expect(remaining.size).toBe(0)
  })

  test('a tick leaves leftover bulk columns for the next tick', () => {
    const keys = ['0,64,0', '16,64,0', '32,64,0', '48,64,0', '64,64,0', '80,64,0']
    const dirty = dirtyOf(keys)
    const first = selectColumnGroupsForTick(dirty, new Set(), BULK_COLUMNS_PER_TICK)
    expect(first.selected).toHaveLength(4)
    expect([...first.remaining.keys()]).toEqual(['64,64,0', '80,64,0'])
    const second = selectColumnGroupsForTick(first.remaining, new Set(), BULK_COLUMNS_PER_TICK)
    expect(second.selected.map(group => `${group.x},${group.z}`)).toEqual(['64,0', '80,0'])
    expect(second.remaining.size).toBe(0)
  })

  test('urgent still wins when the same key also has bulk dirties', () => {
    const dirty = dirtyOf(['16,64,0', '0,64,0', '32,64,0', '48,64,0', '64,64,0', '80,64,0', '96,64,0'])
    dirty.set('0,64,0', 2)
    const { selected, remaining } = selectColumnGroupsForTick(dirty, new Set(['0,64,0']), 4)
    expect(selected[0]).toMatchObject({ x: 0, z: 0 })
    expect(selected).toHaveLength(5)
    expect([...remaining.keys()]).toEqual(['80,64,0', '96,64,0'])
  })
})
