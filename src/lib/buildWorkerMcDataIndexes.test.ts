import { describe, expect, it } from 'vitest'
import { augmentWorkerMcData } from './buildWorkerMcDataIndexes'

describe('augmentWorkerMcData', () => {
  it('is idempotent when mcData is augmented twice (menu then world)', () => {
    const mcData: Record<string, unknown> = {
      entities: [{ name: 'bat', id: 1, type: 'mob' }],
      blocks: [{ name: 'stone', id: 3, minStateId: 48, maxStateId: 63, defaultState: 48 }]
    }
    augmentWorkerMcData(mcData)
    expect(() => augmentWorkerMcData(mcData)).not.toThrow()
    expect(mcData.__workerIndexesBuilt).toBe(true)
    expect(Array.isArray(mcData.blocksArray)).toBe(true)
  })

  it('keeps *Array sources after indexing (esbuild mc-data plugin reads blocksArray)', () => {
    const mcData: Record<string, unknown> = {
      blocks: [{ name: 'stone', id: 3, minStateId: 48, maxStateId: 63, defaultState: 48 }]
    }
    augmentWorkerMcData(mcData)
    expect(Array.isArray(mcData.blocksArray)).toBe(true)
    expect((mcData.blocksArray as unknown[]).length).toBe(1)
    expect(Array.isArray(mcData.blocks)).toBe(false)
  })

  it('coerces valtio-style dense objects into arrays', () => {
    const mcData: Record<string, unknown> = {
      entities: { 0: { name: 'bat', id: 1, type: 'mob' } }
    }
    augmentWorkerMcData(mcData)
    expect((mcData.entitiesByName as Record<string, { name: string }>).bat?.name).toBe('bat')
  })

  it('builds entitiesByName and items indexes from arrays', () => {
    const mcData: Record<string, unknown> = {
      entities: [{ name: 'bat', id: 1, type: 'mob' }],
      items: [{ name: 'dirt', id: 2 }],
      blocks: [{ name: 'stone', id: 3, minStateId: 48, maxStateId: 63, defaultState: 48 }]
    }
    augmentWorkerMcData(mcData)
    expect((mcData.entitiesByName as Record<string, { name: string }>).bat?.name).toBe('bat')
    expect((mcData.entities as Record<number, { id: number }>)[1]?.id).toBe(1)
    expect((mcData.itemsByName as Record<string, unknown>).dirt).toBeDefined()
    expect((mcData.items as Record<number, unknown>)[2]).toBeDefined()
    expect((mcData.blocksByStateId as Record<number, unknown>)[48]).toBeDefined()
  })
})
