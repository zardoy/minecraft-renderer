// Worker-side cache for `convertChunkToWasm` outputs in column mode.
//
// In column-mode meshing, every dirty column triggers a 3x3 conversion
// (target + up to 8 neighbors). During the initial-load wave each column ends
// up being converted up to 9 times (once for itself, once per surrounding
// column that lists it as a neighbor). This cache short-circuits the
// redundant conversions.
//
// Correctness invariants:
// - Cache value MUST NOT be mutated by consumers. The `ChunkConversionResult`
//   typed arrays are used as `set()` SOURCES (and as wasm INPUTS) in the
//   mesher tick, never as destinations, so the read-only contract holds.
// - Identity-based key validation: a hit is served only when the stored
//   chunk reference is `===` the live `world.getColumn(x,z)` reference, so a
//   replaced column (via `world.addColumn`) can never accidentally serve
//   stale data even if the explicit invalidation in the message handler is
//   skipped (defense in depth).
// - In-place mutation of an existing column object (e.g. via
//   `world.setBlockStateId` from a `blockUpdate` message) preserves identity
//   but changes content. The `blockUpdate` handler explicitly invalidates
//   the affected `(chunkX, chunkZ)` to handle this.

import type { ChunkConversionResult } from '../wasm-lib/convertChunk'

// Hard cap on entries. A 12x12 visible area ≈ 144 columns; 64 keeps the hot
// ~8x8 window resident. Tunable.
export const CONVERSION_CACHE_LIMIT = 64

interface CacheEntry {
  chunkRef: any
  version: string
  worldMinY: number
  worldMaxY: number
  result: ChunkConversionResult
}

const cache = new Map<string, CacheEntry>()
let hits = 0
let misses = 0

const keyOf = (x: number, z: number) => `${x},${z}`

const isDev = () => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return typeof process === 'undefined' || process.env?.NODE_ENV !== 'production'
  } catch {
    return true
  }
}

export interface GetOrConvertResult {
  result: ChunkConversionResult
  hit: boolean
}

export function getOrConvertColumn(
  x: number,
  z: number,
  chunkRef: any,
  version: string,
  worldMinY: number,
  worldMaxY: number,
  convert: () => ChunkConversionResult,
  liveChunkRef?: any
): GetOrConvertResult {
  const k = keyOf(x, z)
  const e = cache.get(k)
  if (
    e
    && e.chunkRef === chunkRef
    && e.version === version
    && e.worldMinY === worldMinY
    && e.worldMaxY === worldMaxY
  ) {
    // Defense-in-depth: if the live world ref no longer matches the stored
    // ref, the explicit invalidation path was missed somewhere upstream.
    if (liveChunkRef !== undefined && liveChunkRef !== e.chunkRef) {
      if (isDev()) {
        console.warn(`[WASM Mesher] conversion cache identity drift at ${k} — invalidation likely missed`)
      }
      cache.delete(k)
    } else {
      // LRU bump: re-insert to move to most-recent.
      cache.delete(k)
      cache.set(k, e)
      hits++
      return { result: e.result, hit: true }
    }
  }

  const result = convert()
  cache.delete(k)
  cache.set(k, { chunkRef, version, worldMinY, worldMaxY, result })
  while (cache.size > CONVERSION_CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  misses++
  return { result, hit: false }
}

export function invalidateConversion(x: number, z: number): boolean {
  return cache.delete(keyOf(x, z))
}

export function clearConversionCache(): void {
  cache.clear()
}

export function getConversionCacheSize(): number {
  return cache.size
}

export function consumeConversionCacheStats(): { hits: number, misses: number } {
  const r = { hits, misses }
  hits = 0
  misses = 0
  return r
}

// Test-only helper: peek without bumping LRU or mutating counters.
export function _peekConversionCache(x: number, z: number): CacheEntry | undefined {
  return cache.get(keyOf(x, z))
}
