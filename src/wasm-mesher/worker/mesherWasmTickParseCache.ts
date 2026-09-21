/**
 * Tick-scoped cache for WASM column parses in the two-step mesh path.
 *
 * `getOrConvertColumn` only covers the JS walk. The three WASM converters
 * (`convertRawMapChunkToWasm` / `convertParsedV17ToWasm` / `convertParsedV16ToWasm`)
 * used to re-parse the same neighbour for every dirty target column in a tick.
 * This map lives for one `processColumnTick` and is dropped in `finally`.
 *
 * Same contract as `getOrConvertColumn`: cached values are `set()` sources /
 * WASM inputs only. Consumers must not mutate them, so we do not copy.
 */

let cache: Map<string, unknown> | null = null
let hits = 0
let misses = 0

export function beginTickWasmParseCache(): void {
  cache = new Map()
  hits = 0
  misses = 0
}

export function endTickWasmParseCache(): void {
  cache = null
}

export function getTickWasmParseStats(): { hits: number; misses: number } {
  return { hits, misses }
}

export function getOrConvertTickWasmParse<T>(key: string, convert: () => T | null): { result: T | null; hit: boolean } {
  if (!cache) {
    misses++
    return { result: convert(), hit: false }
  }
  if (cache.has(key)) {
    hits++
    return { result: cache.get(key) as T, hit: true }
  }
  const result = convert()
  misses++
  if (result != null) cache.set(key, result)
  return { result, hit: false }
}
