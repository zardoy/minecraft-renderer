import { afterEach, describe, expect, test } from 'vitest'
import {
  beginTickWasmParseCache,
  endTickWasmParseCache,
  getOrConvertTickWasmParse,
  getTickWasmParseStats
} from '../worker/mesherWasmTickParseCache'

afterEach(() => {
  endTickWasmParseCache()
})

describe('mesherWasmTickParseCache', () => {
  test('second convert of the same column in one tick is a hit without copying', () => {
    beginTickWasmParseCache()
    let calls = 0
    const convert = () => {
      calls++
      return { tag: calls }
    }
    const a = getOrConvertTickWasmParse('0,0', convert)
    const b = getOrConvertTickWasmParse('0,0', convert)
    expect(a.hit).toBe(false)
    expect(b.hit).toBe(true)
    expect(calls).toBe(1)
    expect(b.result).toBe(a.result)
    expect(getTickWasmParseStats()).toEqual({ hits: 1, misses: 1 })
  })

  test('distinct columns miss independently and unique-column count matches the cache', () => {
    beginTickWasmParseCache()
    let calls = 0
    const convert = () => {
      calls++
      return { tag: calls }
    }
    for (let i = 0; i < 9; i++) getOrConvertTickWasmParse(`${i * 16},0`, convert)
    for (let i = 0; i < 9; i++) getOrConvertTickWasmParse(`${i * 16},0`, convert)
    expect(calls).toBe(9)
    expect(getTickWasmParseStats()).toEqual({ hits: 9, misses: 9 })
  })

  test('null results are not cached so a later convert can recover', () => {
    beginTickWasmParseCache()
    let calls = 0
    const a = getOrConvertTickWasmParse('16,16', () => {
      calls++
      return null
    })
    const b = getOrConvertTickWasmParse('16,16', () => {
      calls++
      return { tag: 1 }
    })
    expect(a.result).toBeNull()
    expect(a.hit).toBe(false)
    expect(b.hit).toBe(false)
    expect(b.result).toEqual({ tag: 1 })
    expect(calls).toBe(2)
  })

  test('end of tick drops entries so the next tick misses', () => {
    beginTickWasmParseCache()
    let calls = 0
    getOrConvertTickWasmParse('0,0', () => {
      calls++
      return { tag: 1 }
    })
    endTickWasmParseCache()
    beginTickWasmParseCache()
    getOrConvertTickWasmParse('0,0', () => {
      calls++
      return { tag: 2 }
    })
    expect(calls).toBe(2)
    expect(getTickWasmParseStats()).toEqual({ hits: 0, misses: 1 })
  })
})
