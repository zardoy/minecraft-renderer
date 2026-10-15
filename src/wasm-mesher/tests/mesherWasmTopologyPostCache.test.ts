import { afterEach, describe, expect, test } from 'vitest'
import {
  TOPOLOGY_POST_CACHE_LIMIT,
  clearTopologyPostCache,
  clearTopologyPostCacheColumn,
  getOrComputeTopologyPost
} from '../worker/mesherWasmTopologyPostCache'

afterEach(() => {
  clearTopologyPostCache()
})

describe('mesherWasmTopologyPostCache', () => {
  test('second pass with the same revision does not walk', () => {
    let walks = 0
    const compute = () => {
      walks++
      return { visibilitySet: 1, signs: { a: walks }, heads: {}, banners: {} }
    }
    const first = getOrComputeTopologyPost('0,64,0', 4, compute)
    const second = getOrComputeTopologyPost('0,64,0', 4, compute)
    expect(walks).toBe(1)
    expect(first.hit).toBe(false)
    expect(second.hit).toBe(true)
    expect(second.payload).toBe(first.payload)
  })

  test('revision change walks again', () => {
    let walks = 0
    const compute = () => {
      walks++
      return { visibilitySet: walks, signs: {}, heads: {}, banners: {} }
    }
    getOrComputeTopologyPost('0,64,0', 4, compute)
    const next = getOrComputeTopologyPost('0,64,0', 5, compute)
    expect(walks).toBe(2)
    expect(next.hit).toBe(false)
    expect(next.payload.visibilitySet).toBe(2)
  })

  test('missing revision always walks and does not cache', () => {
    let walks = 0
    const compute = () => {
      walks++
      return { visibilitySet: walks, signs: {}, heads: {}, banners: {} }
    }
    getOrComputeTopologyPost('0,64,0', undefined, compute)
    getOrComputeTopologyPost('0,64,0', undefined, compute)
    expect(walks).toBe(2)
  })

  test('unload of a column clears its cached sections', () => {
    let walks = 0
    const compute = () => {
      walks++
      return { visibilitySet: walks, signs: {}, heads: {}, banners: {} }
    }
    getOrComputeTopologyPost('0,64,0', 3, compute)
    getOrComputeTopologyPost('16,64,0', 3, compute)
    clearTopologyPostCacheColumn(0, 0)
    getOrComputeTopologyPost('0,64,0', 3, compute)
    getOrComputeTopologyPost('16,64,0', 3, compute)
    expect(walks).toBe(3)
  })

  test('evicts oldest entries past the cap', () => {
    for (let i = 0; i < TOPOLOGY_POST_CACHE_LIMIT + 3; i++) {
      getOrComputeTopologyPost(`${i},64,0`, 1, () => ({ visibilitySet: i, signs: {}, heads: {}, banners: {} }))
    }
    let walks = 0
    getOrComputeTopologyPost('0,64,0', 1, () => {
      walks++
      return { visibilitySet: -1, signs: {}, heads: {}, banners: {} }
    })
    expect(walks).toBe(1)
  })
})
