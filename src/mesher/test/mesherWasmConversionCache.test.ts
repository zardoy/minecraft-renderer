import { describe, test, expect, beforeEach, vi } from 'vitest'
import {
  CONVERSION_CACHE_LIMIT,
  _peekConversionCache,
  clearConversionCache,
  getOrConvertColumn,
  invalidateConversion,
} from '../mesherWasmConversionCache'
import type { ChunkConversionResult } from '../../wasm-lib/convertChunk'

const makeResult = (tag: number): ChunkConversionResult => ({
  blockStates: new Uint16Array([tag]),
  blockLight: new Uint8Array(0),
  skyLight: new Uint8Array(0),
  biomesArray: new Uint8Array(0),
  invisibleBlocks: new Uint16Array(0),
  transparentBlocks: new Uint16Array(0),
  noAoBlocks: new Uint16Array(0),
  cullIdenticalBlocks: new Uint16Array(0),
  occludingBlocks: new Uint16Array(0),
  blockCount: 0,
})

describe('mesherWasmConversionCache', () => {
  beforeEach(() => {
    clearConversionCache()
  })

  test('miss then hit on same chunk ref returns cached result', () => {
    const ref = { id: 'chunk-a' }
    let calls = 0
    const convert = () => {
      calls++
      return makeResult(1)
    }
    const a = getOrConvertColumn(0, 0, ref, 'v', 0, 256, convert, ref)
    expect(a.hit).toBe(false)
    expect(calls).toBe(1)
    const b = getOrConvertColumn(0, 0, ref, 'v', 0, 256, convert, ref)
    expect(b.hit).toBe(true)
    expect(calls).toBe(1)
    expect(b.result).toBe(a.result)
  })

  test('miss when chunk reference changes (chunk message replacement)', () => {
    const ref1 = { id: 'r1' }
    const ref2 = { id: 'r2' }
    const r1 = getOrConvertColumn(16, 32, ref1, 'v', 0, 256, () => makeResult(1), ref1)
    const r2 = getOrConvertColumn(16, 32, ref2, 'v', 0, 256, () => makeResult(2), ref2)
    expect(r1.hit).toBe(false)
    expect(r2.hit).toBe(false)
    expect(r2.result).not.toBe(r1.result)
  })

  test('explicit invalidation forces recompute', () => {
    const ref = { id: 'r' }
    const r1 = getOrConvertColumn(0, 0, ref, 'v', 0, 256, () => makeResult(1), ref)
    expect(r1.hit).toBe(false)
    expect(invalidateConversion(0, 0)).toBe(true)
    const r2 = getOrConvertColumn(0, 0, ref, 'v', 0, 256, () => makeResult(2), ref)
    expect(r2.hit).toBe(false)
    expect(_peekConversionCache(0, 0)?.result).toBe(r2.result)
  })

  test('invalidating a non-existent key returns false', () => {
    expect(invalidateConversion(999, 999)).toBe(false)
  })

  test('LRU evicts oldest beyond CONVERSION_CACHE_LIMIT', () => {
    const refs: any[] = []
    for (let i = 0; i < CONVERSION_CACHE_LIMIT + 5; i++) {
      const ref = { id: i }
      refs.push(ref)
      getOrConvertColumn(i * 16, 0, ref, 'v', 0, 256, () => makeResult(i), ref)
    }
    // The first 5 entries should have been evicted.
    for (let i = 0; i < 5; i++) {
      expect(_peekConversionCache(i * 16, 0)).toBeUndefined()
    }
    // The most-recent entries remain.
    for (let i = 5; i < CONVERSION_CACHE_LIMIT + 5; i++) {
      expect(_peekConversionCache(i * 16, 0)).toBeDefined()
    }
  })

  test('hit bumps LRU recency (touched entry survives eviction)', () => {
    const ref0 = { id: 'keep' }
    getOrConvertColumn(0, 0, ref0, 'v', 0, 256, () => makeResult(0), ref0)
    // Fill the cache up to the limit.
    for (let i = 1; i < CONVERSION_CACHE_LIMIT; i++) {
      const ref = { id: i }
      getOrConvertColumn(i * 16, 0, ref, 'v', 0, 256, () => makeResult(i), ref)
    }
    // Touch the oldest (0,0) -> it becomes most-recent.
    const touched = getOrConvertColumn(0, 0, ref0, 'v', 0, 256, () => makeResult(99), ref0)
    expect(touched.hit).toBe(true)
    // Insert one more; the new oldest (16,0) should be evicted, not (0,0).
    const refExtra = { id: 'extra' }
    getOrConvertColumn(9999, 0, refExtra, 'v', 0, 256, () => makeResult(7), refExtra)
    expect(_peekConversionCache(0, 0)).toBeDefined()
    expect(_peekConversionCache(16, 0)).toBeUndefined()
  })

  test('miss when worldMinY/worldMaxY/version metadata changes', () => {
    const ref = { id: 'r' }
    const r1 = getOrConvertColumn(0, 0, ref, 'v1', 0, 256, () => makeResult(1), ref)
    const r2 = getOrConvertColumn(0, 0, ref, 'v2', 0, 256, () => makeResult(2), ref)
    const r3 = getOrConvertColumn(0, 0, ref, 'v2', -64, 256, () => makeResult(3), ref)
    const r4 = getOrConvertColumn(0, 0, ref, 'v2', -64, 320, () => makeResult(4), ref)
    expect(r1.hit).toBe(false)
    expect(r2.hit).toBe(false)
    expect(r3.hit).toBe(false)
    expect(r4.hit).toBe(false)
  })

  test('identity drift between stored and live ref triggers warn + miss', () => {
    const stored = { id: 'old' }
    const live = { id: 'new' } // simulates a missed invalidation path
    const r1 = getOrConvertColumn(0, 0, stored, 'v', 0, 256, () => makeResult(1), stored)
    expect(r1.hit).toBe(false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r2 = getOrConvertColumn(0, 0, stored, 'v', 0, 256, () => makeResult(2), live)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(r2.hit).toBe(false)
    warn.mockRestore()
  })
})
