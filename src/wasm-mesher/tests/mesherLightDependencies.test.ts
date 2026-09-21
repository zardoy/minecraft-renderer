import { describe, expect, test } from 'vitest'
import { provenMeshLightVersion } from '../worker/mesherLightDependencies'

function prove(sx: number, sz: number, used: string[], applied: Array<[string, number]>) {
  return provenMeshLightVersion({
    sx,
    sz,
    usedColumns: new Set(used),
    appliedVersionByColumn: new Map(applied)
  })
}

describe('provenMeshLightVersion', () => {
  test('a bootstrap neighbor wall takes the published column version when that column was meshed', () => {
    expect(prove(16, 0, ['0,0', '16,0'], [['0,0', 10]])).toBe(10)
    expect(prove(0, 16, ['0,0', '0,16'], [['0,0', 8]])).toBe(8)
  })

  test('negative chunk coordinates use the same column keys', () => {
    expect(prove(-16, -32, ['-32,-32', '-16,-32'], [['-32,-32', 7]])).toBe(7)
  })

  test('an unused published column is not proof, even if a dirty job requested that version', () => {
    expect(prove(16, 0, ['16,0'], [['0,0', 10]])).toBe(0)
  })

  test('an older own-column version does not hide a newer neighbor publication that was meshed', () => {
    expect(
      prove(16, 0, ['0,0', '16,0'], [
        ['16,0', 4],
        ['0,0', 10]
      ])
    ).toBe(10)
  })

  test('a later own publication does not cover an earlier neighbor that was left out of the mesh', () => {
    expect(prove(16, 0, ['16,0'], [['0,0', 10], ['16,0', 12]])).toBe(0)
  })

  test('a used column older than the missing neighbor still counts', () => {
    expect(prove(16, 0, ['16,0'], [['0,0', 10], ['16,0', 4]])).toBe(4)
  })

  test('a far column publication does not raise the stamp', () => {
    expect(prove(0, 0, ['0,0', '100,100'], [['100,100', 100]])).toBe(0)
  })

  test('forgetting a column drops it from later proofs', () => {
    const applied = new Map<string, number>([
      ['0,0', 10],
      ['16,0', 10]
    ])
    applied.delete('0,0')
    expect(prove(16, 0, ['16,0'], [...applied.entries()])).toBe(10)
    expect(prove(0, 0, ['0,0'], [...applied.entries()])).toBe(0)
  })
})
