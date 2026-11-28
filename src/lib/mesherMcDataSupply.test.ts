import { describe, expect, it } from 'vitest'
import { getMesherVersionTables } from './mesherMcDataSupply'

describe('getMesherVersionTables', () => {
  it('uses the features table sent with plain mcData (off-thread renderer worker, no supportFeature)', () => {
    const sent = { blockStateId: true, itemsAreAlsoBlocks: false }
    const plain = { version: { minecraftVersion: '1.20.1' }, features: sent } as never
    expect(getMesherVersionTables(plain).features).toBe(sent)
  })

  it('computes the table with supportFeature on the main thread', () => {
    const asked: string[] = []
    const full = {
      type: 'pc',
      version: { minecraftVersion: '1.20.1' },
      supportFeature: (name: string) => {
        asked.push(name)
        return name === 'blockStateId'
      }
    } as never
    const { features } = getMesherVersionTables(full)
    expect(asked.length).toBeGreaterThan(10)
    expect(features.blockStateId).toBe(true)
  })
})
