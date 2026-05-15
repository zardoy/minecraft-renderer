import { Vec3 } from 'vec3'
import { convertChunkToWasm, getBlockMeta, type ChunkConversionResult } from '../bridge/convertChunk'
import { extractColumnHeightmap, splitColumnWasmOutputToSections } from '../bridge/render-from-wasm'
import { setBlockStatesData as setMesherData } from '../../mesher-shared/models'
import { defaultMesherConfig, type MesherGeometryOutput, SECTION_HEIGHT } from '../../mesher-shared/shared'
import { worldColumnKey, World } from '../../mesher-shared/world'
import { handleGetHeightmap, EMPTY_COLUMN_HEIGHTMAP_SENTINEL } from '../../mesher-shared/computeHeightmap'
import { collectBlockEntityMetadata, type SignMeta, type HeadMeta, type BannerMeta } from '../../mesher-shared/blockEntityMetadata'
import { SectionRequestTracker } from './mesherWasmRequestTracker'
import {
  CONVERSION_CACHE_LIMIT,
  clearConversionCache,
  getOrConvertColumn,
  invalidateConversion,
  setConversionCacheLimit,
} from './mesherWasmConversionCache'

let wasm: typeof import('../runtime-build/wasm_mesher.js') | null = null
let wasmInitialized = false

// Pending raw `update_light` packets that arrived before WASM finished
// loading. Parsed and drained once `initWasm` resolves. Without this queue
// the very first batch of chunks (~40-50 in our smoke test) lose their
// real lighting and fall back to fill(15) — which makes shadowed areas
// (under trees, cliff edges) look brighter than vanilla, and after the
// renderer interpolates with neighbour chunks that DO have real light,
// the seams look like "local night".
const pendingUpdateLightV17: Array<{ rawPacket: Uint8Array, numSections: number }> = []
// Separate v16 pending queue so 1.16 update_light packets that arrive
// before WASM is initialised land in the v16 light cache (not v17) on
// drain — the mesh hot path looks them up per protocol family.
const pendingUpdateLightV16: Array<{ rawPacket: Uint8Array }> = []

function processUpdateLightV17 (rawPacket: Uint8Array, numSections: number): void {
  if (!wasm || !(wasm as any).parseUpdateLightV17) {
    pendingUpdateLightV17.push({ rawPacket, numSections })
    return
  }
  try {
    const parsed: any = (wasm as any).parseUpdateLightV17(rawPacket, numSections)
    const x = (parsed.x as number) * 16
    const z = (parsed.z as number) * 16
    updateLightV17Cache.set(rawCacheKey(x, z), {
      skyLight: parsed.skyLight as Uint8Array,
      blockLight: parsed.blockLight as Uint8Array,
    })
    invalidateConversion(x, z)
  } catch (err) {
    console.warn('[WASM Mesher] parseUpdateLightV17 failed:', err)
  }
}

// 1.16 update_light shares the wire format (and the WASM parser) with
// 1.17, but we keep a SEPARATE result cache to keep the two protocol
// families fully isolated — the mesh tick picks v16 vs v17 by which raw
// chunk cache has the entry, and crossing the streams could mismatch a
// stale 1.17 column with 1.16 light or vice versa during version switches.
function processUpdateLightV16 (rawPacket: Uint8Array): void {
  if (!wasm || !(wasm as any).parseUpdateLightV17) {
    pendingUpdateLightV16.push({ rawPacket })
    return
  }
  try {
    const parsed: any = (wasm as any).parseUpdateLightV17(rawPacket, 16)
    const x = (parsed.x as number) * 16
    const z = (parsed.z as number) * 16
    updateLightV16Cache.set(rawCacheKey(x, z), {
      skyLight: parsed.skyLight as Uint8Array,
      blockLight: parsed.blockLight as Uint8Array,
    })
    invalidateConversion(x, z)
  } catch (err) {
    console.warn('[WASM Mesher] parseUpdateLightV17 (v16) failed:', err)
  }
}

async function initWasm() {
  if (wasmInitialized) return
  try {
    wasmInitialized = true
    wasm = await import('../runtime-build/wasm_mesher.js')
    await wasm.default('/wasm_mesher_bg.wasm') as any

    if (pendingUpdateLightV17.length > 0) {
      console.log('[WASM Mesher] draining', pendingUpdateLightV17.length, 'pending update_light v17 packets')
      const queue = pendingUpdateLightV17.splice(0, pendingUpdateLightV17.length)
      for (const item of queue) processUpdateLightV17(item.rawPacket, item.numSections)
    }

    if (pendingUpdateLightV16.length > 0) {
      console.log('[WASM Mesher] draining', pendingUpdateLightV16.length, 'pending update_light v16 packets')
      const queue = pendingUpdateLightV16.splice(0, pendingUpdateLightV16.length)
      for (const item of queue) processUpdateLightV16(item.rawPacket)
    }
  } catch (err) {
    console.error('Failed to initialize WASM mesher:', err)
    wasmInitialized = true // Don't try to initialize again
    // Don't throw - allow worker to continue without WASM (will fail on first use)
  }
}

globalThis.structuredClone ??= (value) => JSON.parse(JSON.stringify(value))

if (globalThis.module && module.require) {
  // If we are in a node environment, we need to fake some env variables
  const r = module.require
  const { parentPort } = r('worker_threads')
  global.self = parentPort
  global.postMessage = (value, transferList) => { parentPort.postMessage(value, transferList) }
  global.performance = r('perf_hooks').performance
}

let workerIndex = 0
let config = defaultMesherConfig
let version = '1.16.5'
let world: World // chunkKey -> chunk data
let dirtySections = new Map<string, number>()
// Kept in sync with `dirtySections` so column mode can filter outgoing
// geometry/sectionFinished events to only the section keys requested by the
// main thread, even though a full-column WASM call may generate more data.
const requestTracker = new SectionRequestTracker()
let allDataReady = false

function sectionKey(x: number, y: number, z: number) {
  return `${x},${y},${z}`
}

const batchMessagesLimit = 100

let queuedMessages: any[] = []
let queueWaiting = false
const postMessage = (data: any, transferList: any[] = []) => {
  queuedMessages.push({ data, transferList })
  if (queuedMessages.length > batchMessagesLimit) {
    drainQueue(0, batchMessagesLimit)
  }
  if (queueWaiting) return
  queueWaiting = true
  setTimeout(() => {
    queueWaiting = false
    drainQueue(0, queuedMessages.length)
  })
}

function drainQueue(from: number, to: number) {
  const messages = queuedMessages.slice(from, to)
  global.postMessage(messages.map(m => m.data), messages.flatMap(m => m.transferList) as unknown as string)
  queuedMessages = queuedMessages.slice(to)
}

// Single emit point for `sectionFinished`. Consumes one pending request from
// `requestTracker` and posts via the existing batched `postMessage` queue.
//
// Column-mode is the ONLY WASM path now: an emit for a non-requested key is a
// contract violation (`WorldRendererCommon` would throw on the main thread)
// and we surface it via `console.warn` so it shows up in dev/CI without
// killing the worker.
const emitSectionFinished = (payload: { type: 'sectionFinished', key: string } & Record<string, any>) => {
  const consumed = requestTracker.consumeOne(payload.key)
  if (!consumed) {
    console.warn(`[WASM Mesher] sectionFinished for non-requested key ${payload.key} (column-mode contract violation)`)
  }
  postMessage(payload)
}

let hadDirty = false
function setSectionDirty(pos: Vec3, value = true) {
  if (hadDirty) return

  // hadDirty = true
  const x = Math.floor(pos.x / 16) * 16
  const sectionHeight = getSectionHeight()
  const y = Math.floor(pos.y / sectionHeight) * sectionHeight
  const z = Math.floor(pos.z / 16) * 16
  const key = sectionKey(x, y, z)
  if (!value) {
    dirtySections.delete(key)
    // The main thread waits for a sectionFinished response to dirty=false too.
    // Record + consume it so request accounting stays balanced.
    requestTracker.addRequest(key)
    emitSectionFinished({ type: 'sectionFinished', key, workerIndex })
    return
  }

  // Check if we have the chunk for this section
  const chunk = world?.getColumn(x, z)
  if (chunk?.getSection(pos)) {
    dirtySections.set(key, (dirtySections.get(key) || 0) + 1)
    requestTracker.addRequest(key)
  } else {
    // Missing chunks still owe the main thread a sectionFinished response.
    requestTracker.addRequest(key)
    emitSectionFinished({ type: 'sectionFinished', key, workerIndex })
  }
}

const softCleanup = () => {
  world = new World(world.config.version)
  globalThis.world = world
}

// Stage 3 (issue-15-wasm): cache of raw `map_chunk` packets keyed by
// `"x,z"`. Populated from the main thread (`setRawMapChunk` message), used
// to bypass the JS hot loop `convertChunkToWasm` for protocol >= 757
// (1.18+). Block updates / chunk unload invalidate entries so we fall back
// to the legacy column-walk path until the next `map_chunk` arrives.
interface RawMapChunkEntry {
  rawPacket: Uint8Array
  protocol: number
  numSections: number
}
const rawMapChunkCache = new Map<string, RawMapChunkEntry>()
const rawCacheKey = (x: number, z: number) => `${x},${z}`

// 1.17 path: pre-extracted section bytes + bit mask (mineflayer already
// did the cheap top-level packet parsing on the main thread).
interface ParsedV17Entry {
  protocol: number
  numSections: number
  maxBitsPerBlock: number
  chunkData: Uint8Array
  bitMapLoHi: Uint32Array
  biomes?: Int32Array
}
const parsedV17Cache = new Map<string, ParsedV17Entry>()

// 1.17 light arrives in a separate `update_light` packet. We parse it via
// WASM (`parseUpdateLightV17`) and cache per-block arrays keyed by the
// chunk origin — the next mesh tick of that column merges them in instead
// of the sky=15/block=0 fallback. May arrive before or after `map_chunk`.
interface UpdateLightV17Entry {
  skyLight: Uint8Array
  blockLight: Uint8Array
}
const updateLightV17Cache = new Map<string, UpdateLightV17Entry>()

// 1.16 path: pre-extracted section bytes + bit mask. Bit mask in 1.16
// is a varint that fits in i32 (only 16 sections), so we accept it as a
// single number and widen to a [lo,hi]=[bitMap,0] u32 pair when calling
// the shared `parseChunkSectionsV16V17` parser. Held separately from the
// v17 cache to keep the two protocol families isolated during version
// switches; mesh tick picks v16 vs v17 by which cache holds the entry.
interface ParsedV16Entry {
  protocol: number
  chunkData: Uint8Array
  bitMap: number
  biomes: Int32Array
}
const parsedV16Cache = new Map<string, ParsedV16Entry>()

// 1.16 sky/block light cache — same shape as the v17 entry, populated by
// `processUpdateLightV16` (which calls the shared `parseUpdateLightV17`
// WASM export). Separate map for the same isolation reasons as
// `parsedV16Cache` above.
const updateLightV16Cache = new Map<string, UpdateLightV17Entry>()

// Mirrors `convertChunkToWasm`'s output (same layout: x + z*16 + y*256,
// y outer) so it can be dropped straight into `generate_geometry`.
const convertRawMapChunkToWasm = (
  raw: RawMapChunkEntry,
  version: string
): ChunkConversionResult | null => {
  if (!wasm || !(wasm as any).parseMapChunkV18Plus) return null
  // 1.18 introduced the new chunk format; on earlier protocols the packet
  // shape differs and our parser would throw. Fall back to the JS path.
  if (raw.protocol < 757) return null
  // max_bits_per_block / max_bits_per_biome match the parity-tested defaults
  // in `wasm-mesher/src/parser_v18plus.rs` (see Stage 2 fixtures).
  const MAX_BITS_PER_BLOCK = 8
  const MAX_BITS_PER_BIOME = 3
  let parsed: any
  try {
    parsed = (wasm as any).parseMapChunkV18Plus(
      raw.rawPacket,
      raw.numSections,
      MAX_BITS_PER_BLOCK,
      MAX_BITS_PER_BIOME,
      raw.protocol
    )
  } catch (err) {
    console.warn('[WASM Mesher] parseMapChunkV18Plus failed, falling back:', err)
    return null
  }
  const meta = getBlockMeta(version)
  const blockStates: Uint16Array = parsed.blockStates
  let blockCount = 0
  for (let i = 0; i < blockStates.length; i++) {
    if (blockStates[i] !== 0) blockCount++
  }
  return {
    blockStates,
    blockLight: parsed.blockLight,
    skyLight: parsed.skyLight,
    biomesArray: parsed.biomes,
    invisibleBlocks: meta.invisibleBlocks,
    transparentBlocks: meta.transparentBlocks,
    noAoBlocks: meta.noAoBlocks,
    cullIdenticalBlocks: meta.cullIdenticalBlocks,
    occludingBlocks: meta.occludingBlocks,
    blockCount,
  }
}

// 1.17 conversion: WASM now returns blockStates **and** per-block biomes
// (expanded from the 4×4×4 cell layout). Light comes from the paired
// `update_light` cache when available; otherwise we fall back to full
// daylight (sky=15) and no block light so geometry stays visible.
const convertParsedV17ToWasm = (
  entry: ParsedV17Entry,
  lightEntry: UpdateLightV17Entry | undefined,
  version: string
): ChunkConversionResult | null => {
  if (!wasm || !(wasm as any).parseChunkSectionsV16V17) return null
  // Empty `Int32Array` signals "no biomes captured" — WASM falls back to
  // `default_biome` for every block. Plains (id 1) matches the JS path.
  const biomesCells = entry.biomes ?? new Int32Array(0)
  const DEFAULT_BIOME = 1
  let parsed: any
  try {
    parsed = (wasm as any).parseChunkSectionsV16V17(
      entry.chunkData,
      entry.bitMapLoHi,
      entry.numSections,
      entry.maxBitsPerBlock,
      biomesCells,
      DEFAULT_BIOME,
    )
  } catch (err) {
    console.warn('[WASM Mesher] parseChunkSectionsV16V17 failed, falling back:', err)
    return null
  }
  const blockStates: Uint16Array = parsed.blockStates
  const totalBlocks = blockStates.length
  let blockLight: Uint8Array
  let skyLight: Uint8Array
  if (lightEntry && lightEntry.skyLight.length === totalBlocks) {
    skyLight = lightEntry.skyLight
    blockLight = lightEntry.blockLight
  } else {
    blockLight = new Uint8Array(totalBlocks)
    skyLight = new Uint8Array(totalBlocks)
    skyLight.fill(15)
  }
  const biomesArray: Uint8Array = parsed.biomes
  let blockCount = 0
  for (let i = 0; i < totalBlocks; i++) {
    if (blockStates[i] !== 0) blockCount++
  }
  const meta = getBlockMeta(version)
  return {
    blockStates,
    blockLight,
    skyLight,
    biomesArray,
    invisibleBlocks: meta.invisibleBlocks,
    transparentBlocks: meta.transparentBlocks,
    noAoBlocks: meta.noAoBlocks,
    cullIdenticalBlocks: meta.cullIdenticalBlocks,
    occludingBlocks: meta.occludingBlocks,
    blockCount,
  }
}

// 1.16 conversion: shares the WASM parser with 1.17 (chunk-section wire
// format is identical between 1.16.x and 1.17). The fixed parameters
// (16 sections, max_bits_per_block=14) match the prismarine-chunk@1.16
// defaults — anything else means a non-vanilla server we don't support
// on the fast path, in which case we return null and fall back to the
// JS column-walk via `convertChunkToWasm`.
const convertParsedV16ToWasm = (
  entry: ParsedV16Entry,
  lightEntry: UpdateLightV17Entry | undefined,
  version: string
): ChunkConversionResult | null => {
  if (!wasm || !(wasm as any).parseChunkSectionsV16V17) return null
  const NUM_SECTIONS = 16
  const MAX_BITS_PER_BLOCK = 15
  const DEFAULT_BIOME = 1
  // 1.16 bit mask is a varint that fits in i32 (only 16 sections used);
  // the WASM parser still expects [lo,hi] u32 pairs (one pair per long),
  // so widen the single number to [bitMap, 0].
  const bitMapLoHi = new Uint32Array([entry.bitMap >>> 0, 0])
  const biomesCells = entry.biomes ?? new Int32Array(0)
  let parsed: any
  try {
    parsed = (wasm as any).parseChunkSectionsV16V17(
      entry.chunkData,
      bitMapLoHi,
      NUM_SECTIONS,
      MAX_BITS_PER_BLOCK,
      biomesCells,
      DEFAULT_BIOME,
    )
  } catch (err) {
    console.warn('[WASM Mesher] parseChunkSectionsV16V17 (v16) failed, falling back:', err)
    return null
  }
  const blockStates: Uint16Array = parsed.blockStates
  const totalBlocks = blockStates.length
  let blockLight: Uint8Array
  let skyLight: Uint8Array
  if (lightEntry && lightEntry.skyLight.length === totalBlocks) {
    skyLight = lightEntry.skyLight
    blockLight = lightEntry.blockLight
  } else {
    blockLight = new Uint8Array(totalBlocks)
    skyLight = new Uint8Array(totalBlocks)
    skyLight.fill(15)
  }
  const biomesArray: Uint8Array = parsed.biomes
  let blockCount = 0
  for (let i = 0; i < totalBlocks; i++) {
    if (blockStates[i] !== 0) blockCount++
  }
  const meta = getBlockMeta(version)
  return {
    blockStates,
    blockLight,
    skyLight,
    biomesArray,
    invisibleBlocks: meta.invisibleBlocks,
    transparentBlocks: meta.transparentBlocks,
    noAoBlocks: meta.noAoBlocks,
    cullIdenticalBlocks: meta.cullIdenticalBlocks,
    occludingBlocks: meta.occludingBlocks,
    blockCount,
  }
}

// ---------------------------------------------------------------------------
// Fused parse+mesh helpers (single WASM call, no typed arrays in JS heap)
// ---------------------------------------------------------------------------

const MAX_BITS_PER_BLOCK = 8
const MAX_BITS_PER_BIOME = 3

/// Fused single-column mesh for 1.18+ raw map_chunk.
/// Returns the GeometryOutput directly (or null on failure → fallback).
const meshColumnFromRawV18Plus = (
  raw: RawMapChunkEntry,
  x: number,
  z: number,
  worldMinY: number,
  worldMaxY: number,
  meta: ReturnType<typeof getBlockMeta>
): any | null => {
  if (!wasm || !(wasm as any).generateGeometryFromMapChunkV18Plus) return null
  if (raw.protocol < 757) return null
  const columnHeight = worldMaxY - worldMinY
  try {
    return (wasm as any).generateGeometryFromMapChunkV18Plus(
      raw.rawPacket,
      raw.numSections,
      MAX_BITS_PER_BLOCK,
      MAX_BITS_PER_BIOME,
      raw.protocol,
      x, worldMinY, z, columnHeight,
      worldMinY, worldMaxY,
      worldMinY,
      meta.invisibleBlocks,
      meta.transparentBlocks,
      meta.noAoBlocks,
      meta.cullIdenticalBlocks,
      meta.occludingBlocks,
      config?.enableLighting !== false,
      config?.smoothLighting !== false,
      config?.skyLight || 15
    )
  } catch (err) {
    console.warn('[WASM Mesher] generateGeometryFromMapChunkV18Plus failed, falling back:', err)
    return null
  }
}

/// Fused single-column mesh for 1.16 / 1.17 pre-parsed chunk sections.
const meshColumnFromParsedV16V17 = (
  chunkData: Uint8Array,
  bitMapLoHi: Uint32Array,
  numSections: number,
  maxBitsPerBlock: number,
  biomesCells: Int32Array | undefined,
  defaultBiome: number,
  skyLight: Uint8Array | null,
  blockLight: Uint8Array | null,
  x: number,
  z: number,
  worldMinY: number,
  worldMaxY: number,
  meta: ReturnType<typeof getBlockMeta>
): any | null => {
  if (!wasm || !(wasm as any).generateGeometryFromParsedV16V17) return null
  const columnHeight = worldMaxY - worldMinY
  try {
    return (wasm as any).generateGeometryFromParsedV16V17(
      chunkData,
      bitMapLoHi,
      numSections,
      maxBitsPerBlock,
      biomesCells ?? new Int32Array(0),
      defaultBiome,
      skyLight ?? new Uint8Array(0),
      blockLight ?? new Uint8Array(0),
      x, worldMinY, z, columnHeight,
      worldMinY, worldMaxY,
      worldMinY,
      meta.invisibleBlocks,
      meta.transparentBlocks,
      meta.noAoBlocks,
      meta.cullIdenticalBlocks,
      meta.occludingBlocks,
      config?.enableLighting !== false,
      config?.smoothLighting !== false,
      config?.skyLight || 15
    )
  } catch (err) {
    console.warn('[WASM Mesher] generateGeometryFromParsedV16V17 failed, falling back:', err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Fused multi-column helpers.
// Zero-alloc: reuse existing TypedArray buffers from caches, no concat.
// ---------------------------------------------------------------------------

const meshMultiColumnsFromRawV18Plus = (
  chunksToUse: Array<{ x: number, z: number, chunk: any }>,
  x: number,
  z: number,
  worldMinY: number,
  worldMaxY: number,
  meta: ReturnType<typeof getBlockMeta>
): any | null => {
  if (!wasm || !(wasm as any).generateGeometryFromMapChunkV18PlusMulti) return null
  const chunkCount = chunksToUse.length
  if (chunkCount === 0) return null

  const rawPackets: Uint8Array[] = []
  const numSectionsList = new Uint32Array(chunkCount)
  const chunkXs = new Int32Array(chunkCount)
  const chunkZs = new Int32Array(chunkCount)
  let protocol = 0

  for (let i = 0; i < chunkCount; i++) {
    const raw = rawMapChunkCache.get(rawCacheKey(chunksToUse[i].x, chunksToUse[i].z))
    if (!raw || raw.protocol < 757) return null
    rawPackets.push(raw.rawPacket)
    numSectionsList[i] = raw.numSections
    chunkXs[i] = chunksToUse[i].x
    chunkZs[i] = chunksToUse[i].z
    if (i === 0) protocol = raw.protocol
  }

  const columnHeight = worldMaxY - worldMinY
  try {
    return (wasm as any).generateGeometryFromMapChunkV18PlusMulti(
      rawPackets,
      numSectionsList,
      MAX_BITS_PER_BLOCK,
      MAX_BITS_PER_BIOME,
      protocol,
      chunkXs,
      chunkZs,
      x, worldMinY, z, columnHeight,
      worldMinY, worldMaxY,
      worldMinY,
      meta.invisibleBlocks,
      meta.transparentBlocks,
      meta.noAoBlocks,
      meta.cullIdenticalBlocks,
      meta.occludingBlocks,
      config?.enableLighting !== false,
      config?.smoothLighting !== false,
      config?.skyLight || 15
    )
  } catch (err) {
    console.warn('[WASM Mesher] generateGeometryFromMapChunkV18PlusMulti failed:', err)
    return null
  }
}

const meshMultiColumnsFromParsedV16V17 = (
  chunksToUse: Array<{ x: number, z: number, chunk: any }>,
  x: number,
  z: number,
  worldMinY: number,
  worldMaxY: number,
  meta: ReturnType<typeof getBlockMeta>
): any | null => {
  if (!wasm || !(wasm as any).generateGeometryFromParsedV16V17Multi) return null
  const chunkCount = chunksToUse.length
  if (chunkCount === 0) return null

  // Determine which cache family owns all columns. Homogeneity is
  // guaranteed by the server protocol version: v16 and v17 caches are
  // never populated simultaneously within a session.
  let family: 'v17' | 'v16' | null = null
  for (let i = 0; i < chunkCount; i++) {
    const key = rawCacheKey(chunksToUse[i].x, chunksToUse[i].z)
    if (parsedV17Cache.has(key)) {
      if (family === 'v16') return null
      family = 'v17'
    } else if (parsedV16Cache.has(key)) {
      if (family === 'v17') return null
      family = 'v16'
    } else {
      return null
    }
  }
  if (!family) return null

  const chunkDataList: Uint8Array[] = []
  const biomesList: Int32Array[] = []
  const skyLightList: Uint8Array[] = []
  const blockLightList: Uint8Array[] = []
  const numSectionsList = new Uint32Array(chunkCount)
  const chunkXs = new Int32Array(chunkCount)
  const chunkZs = new Int32Array(chunkCount)
  const bitMapLoHi = new Uint32Array(chunkCount * 2)
  let maxBitsPerBlock = 15

  for (let i = 0; i < chunkCount; i++) {
    const key = rawCacheKey(chunksToUse[i].x, chunksToUse[i].z)
    if (family === 'v17') {
      const entry = parsedV17Cache.get(key)!
      chunkDataList.push(entry.chunkData)
      biomesList.push(entry.biomes ?? new Int32Array(0))
      numSectionsList[i] = entry.numSections
      bitMapLoHi[i * 2] = entry.bitMapLoHi[0]
      bitMapLoHi[i * 2 + 1] = entry.bitMapLoHi[1]
      if (i === 0) maxBitsPerBlock = entry.maxBitsPerBlock
      const light = updateLightV17Cache.get(key)
      skyLightList.push(light?.skyLight ?? new Uint8Array(0))
      blockLightList.push(light?.blockLight ?? new Uint8Array(0))
    } else {
      const entry = parsedV16Cache.get(key)!
      chunkDataList.push(entry.chunkData)
      biomesList.push(entry.biomes ?? new Int32Array(0))
      numSectionsList[i] = 16
      const bm = entry.bitMap >>> 0
      bitMapLoHi[i * 2] = bm
      bitMapLoHi[i * 2 + 1] = 0
      const light = updateLightV16Cache.get(key)
      skyLightList.push(light?.skyLight ?? new Uint8Array(0))
      blockLightList.push(light?.blockLight ?? new Uint8Array(0))
    }
    chunkXs[i] = chunksToUse[i].x
    chunkZs[i] = chunksToUse[i].z
  }

  const columnHeight = worldMaxY - worldMinY
  try {
    return (wasm as any).generateGeometryFromParsedV16V17Multi(
      chunkDataList,
      bitMapLoHi,
      numSectionsList,
      maxBitsPerBlock,
      biomesList,
      1,
      skyLightList,
      blockLightList,
      chunkXs,
      chunkZs,
      x, worldMinY, z, columnHeight,
      worldMinY, worldMaxY,
      worldMinY,
      meta.invisibleBlocks,
      meta.transparentBlocks,
      meta.noAoBlocks,
      meta.cullIdenticalBlocks,
      meta.occludingBlocks,
      config?.enableLighting !== false,
      config?.smoothLighting !== false,
      config?.skyLight || 15
    )
  } catch (err) {
    console.warn('[WASM Mesher] generateGeometryFromParsedV16V17Multi failed:', err)
    return null
  }
}

const handleMessage = async (data: any) => {
  const globalVar: any = globalThis

  if (data.type === 'mcData') {
    globalVar.mcData = data.mcData
    globalVar.loadedData = data.mcData
  }

  if (data.config) {
    config = { ...config, ...data.config }
    version = config.version || version
    world ??= new World(version)
    world.config = { ...world.config, ...data.config }
    globalThis.world = world
    globalThis.Vec3 = Vec3
    setConversionCacheLimit(config.disableConversionCache ? 0 : CONVERSION_CACHE_LIMIT)
  }

  switch (data.type) {
    case 'mesherData': {
      setMesherData(data.blockstatesModels, data.blocksAtlas, data.config.outputFormat === 'webgpu')
      ;(globalThis as any).__wasmBlockModelCache = new Map()
      // Conservative: blockstates/version/world config may have changed.
      clearConversionCache()

      await initWasm()
      allDataReady = true
      workerIndex = data.workerIndex
      break
    }
    case 'dirty': {
      const loc = new Vec3(data.x, data.y, data.z)
      setSectionDirty(loc, data.value)
      break
    }
    case 'chunk': {
      // Invalidate BEFORE replacing the column reference so a stale entry
      // can never outlive the old chunk object.
      invalidateConversion(data.x, data.z)
      if (!world) break
      world.addColumn(data.x, data.z, data.chunk)
      if (data.customBlockModels) {
        const chunkKey = `${data.x},${data.z}`
        world.customBlockModels.set(chunkKey, data.customBlockModels)
      }
      // Safety-net heightmap push for fully empty columns. With WASM
      // mesher as the sole path, the main thread no longer requests
      // `getHeightmap` on chunk load — heightmaps come from
      // `processColumnTick`. But a fully empty column (no sections, or
      // all sections missing) never enters that path because
      // `setSectionDirty` short-circuits when `chunk.getSection(pos)` is
      // falsy, so `processColumnTick` never sees it. Without this push
      // downstream consumers (e.g. `rain.ts`) would have no heightmap
      // entry for such columns. We send a cheap sentinel-filled
      // `Int16Array(256).fill(-32768)` — no JS heightmap scan — only when
      // we detect zero sections; non-empty columns get their real
      // heightmap from the next `processColumnTick`.
      const sectionH = SECTION_HEIGHT
      const minY = config?.worldMinY ?? 0
      const maxY = config?.worldMaxY ?? 256
      const column = world.getColumn(data.x, data.z)
      let hasAnySection = false
      for (let y = minY; y < maxY; y += sectionH) {
        if (column?.getSection?.(new Vec3(0, y, 0))) {
          hasAnySection = true
          break
        }
      }
      if (!hasAnySection) {
        const emptyHeightmap = new Int16Array(256).fill(EMPTY_COLUMN_HEIGHTMAP_SENTINEL)
        postMessage(
          { type: 'heightmap', key: `${data.x >> 4},${data.z >> 4}`, heightmap: emptyHeightmap },
          [emptyHeightmap.buffer]
        )
      }
      break
    }
    case 'unloadChunk': {
      invalidateConversion(data.x, data.z)
      rawMapChunkCache.delete(rawCacheKey(data.x, data.z))
      parsedV17Cache.delete(rawCacheKey(data.x, data.z))
      updateLightV17Cache.delete(rawCacheKey(data.x, data.z))
      parsedV16Cache.delete(rawCacheKey(data.x, data.z))
      updateLightV16Cache.delete(rawCacheKey(data.x, data.z))
      if (!world) break
      world.removeColumn(data.x, data.z)
      world.customBlockModels.delete(`${data.x},${data.z}`)
      if (Object.keys(world.columns).length === 0) softCleanup()
      break
    }
    case 'blockUpdate': {
      const loc = new Vec3(data.pos.x, data.pos.y, data.pos.z).floored()
      if (data.stateId !== undefined && data.stateId !== null) {
        world?.setBlockStateId(loc, data.stateId)
      }

      const chunkX = Math.floor(loc.x / 16) * 16
      const chunkZ = Math.floor(loc.z / 16) * 16
      // In-place mutation preserves chunk identity; explicit invalidation
      // is required so the next tick recomputes from current block state.
      invalidateConversion(chunkX, chunkZ)
      // Stage 3: the cached raw map_chunk no longer matches the live
      // column after a block update — drop it so the next mesh tick walks
      // the (now-updated) prismarine column instead.
      rawMapChunkCache.delete(rawCacheKey(chunkX, chunkZ))
      parsedV17Cache.delete(rawCacheKey(chunkX, chunkZ))
      parsedV16Cache.delete(rawCacheKey(chunkX, chunkZ))
      const chunkKey = `${chunkX},${chunkZ}`
      if (data.customBlockModels) {
        world?.customBlockModels.set(chunkKey, data.customBlockModels)
      }
      break
    }
    case 'setRawMapChunk': {
      // Stage 3 (issue-15-wasm): main thread captured the raw map_chunk
      // bytes mineflayer received and forwarded them here. We cache by
      // (x,z); the next mesh tick will prefer this raw entry over the JS
      // column-walk path. Invalidate the existing conversion cache entry
      // so the next mesh tick picks the new path even if the column
      // identity is unchanged.
      rawMapChunkCache.set(rawCacheKey(data.x, data.z), {
        rawPacket: data.rawPacket as Uint8Array,
        protocol: data.protocol as number,
        numSections: data.numSections as number,
      })
      invalidateConversion(data.x, data.z)
      break
    }
    case 'setParsedMapChunkV17': {
      // 1.17 path: pre-extracted section bytes + bit mask from mineflayer.
      parsedV17Cache.set(rawCacheKey(data.x, data.z), {
        protocol: data.protocol as number,
        numSections: data.numSections as number,
        maxBitsPerBlock: data.maxBitsPerBlock as number,
        chunkData: data.chunkData as Uint8Array,
        bitMapLoHi: data.bitMapLoHi as Uint32Array,
        biomes: data.biomes as Int32Array | undefined,
      })
      invalidateConversion(data.x, data.z)
      break
    }
    case 'setUpdateLightV17': {
      // 1.17 path: parse the raw `update_light` packet via WASM. The
      // (chunkX, chunkZ) come back inside the result — JS doesn't peek at
      // varints. May arrive before or after the matching map_chunk; either
      // way we cache and invalidate the column conversion so the next tick
      // merges real lighting in.
      // If WASM isn't ready yet, the packet is queued in
      // `pendingUpdateLightV17` and replayed by `initWasm`.
      processUpdateLightV17(data.rawPacket as Uint8Array, data.numSections as number)
      break
    }
    case 'setParsedMapChunkV16': {
      // 1.16 path: pre-extracted section bytes + (single-number) bit mask
      // from mineflayer. Stored separately from v17 to keep the two
      // protocol families isolated during version switches.
      parsedV16Cache.set(rawCacheKey(data.x, data.z), {
        protocol: data.protocol as number,
        chunkData: data.chunkData as Uint8Array,
        bitMap: data.bitMap as number,
        biomes: data.biomes as Int32Array,
      })
      invalidateConversion(data.x, data.z)
      break
    }
    case 'setUpdateLightV16': {
      // 1.16 path: shares the wire format / WASM parser with 1.17 but
      // populates a separate `updateLightV16Cache`. Same pre-WASM queueing
      // semantics as v17.
      processUpdateLightV16(data.rawPacket as Uint8Array)
      break
    }
    case 'reset': {
      world = undefined as any
      dirtySections.clear()
      requestTracker.clear()
      clearConversionCache()
      rawMapChunkCache.clear()
      parsedV17Cache.clear()
      updateLightV17Cache.clear()
      parsedV16Cache.clear()
      updateLightV16Cache.clear()
      globalVar.mcData = null
      globalVar.loadedData = null
      allDataReady = false
      break
    }
    case 'mc-web-ping': {
      const replyWorkerIndex = typeof data.workerIndex === 'number' ? data.workerIndex : workerIndex
      global.postMessage({
        type: 'mc-web-pong',
        workerIndex: replyWorkerIndex,
        t: data.t,
        recvAt: typeof performance !== 'undefined' ? performance.now() : undefined,
      })
      break
    }
    case 'mc-web-ping': {
      const replyWorkerIndex = typeof data.workerIndex === 'number' ? data.workerIndex : workerIndex
      global.postMessage({
        type: 'mc-web-pong',
        workerIndex: replyWorkerIndex,
        t: data.t,
        recvAt: typeof performance !== 'undefined' ? performance.now() : undefined,
      })
      break
    }
    case 'mc-web-ping': {
      const replyWorkerIndex = typeof data.workerIndex === 'number' ? data.workerIndex : workerIndex
      global.postMessage({
        type: 'mc-web-pong',
        workerIndex: replyWorkerIndex,
        t: data.t,
        recvAt: typeof performance !== 'undefined' ? performance.now() : undefined,
      })
      break
    }
    case 'getHeightmap': {
      // Fallback path. With WASM column mesher as the sole path, the main
      // thread should be receiving heightmaps as `'heightmap'` push messages
      // posted by `processColumnTick`. This handler stays as a safety net for
      // cases where the WASM heightmap could not be extracted (length mismatch
      // or missing field) — see the `extractColumnHeightmap` warn below.
      console.warn(`[WASM Mesher] explicit getHeightmap request for ${data.x},${data.z} — push from processColumnTick missed?`)
      if (!world) {
        const emptyHeightmap = new Int16Array(256).fill(EMPTY_COLUMN_HEIGHTMAP_SENTINEL)
        postMessage({ type: 'heightmap', key: `${Math.floor(data.x / 16)},${Math.floor(data.z / 16)}`, heightmap: emptyHeightmap })
        break
      }
      const { key, heightmap } = handleGetHeightmap(world, data.x, data.z)
      postMessage({ type: 'heightmap', key, heightmap }, [heightmap.buffer])

      break
    }
    // Note: getCustomBlockModel not implemented in WASM version
    // as it requires World class functionality
  }
}

// eslint-disable-next-line no-restricted-globals -- TODO
self.onmessage = ({ data }) => {
  if (Array.isArray(data)) {
    // eslint-disable-next-line unicorn/no-array-for-each
    data.forEach(handleMessage)
    return
  }

  handleMessage(data)
}

// Section height is always 16 in column mode (the only WASM path).
const getSectionHeight = () => SECTION_HEIGHT


// 3x3 X/Z neighbor set for column meshing. Y-agnostic because full-column
// meshing converts the entire world Y range in one go.
function collectChunksForColumn(x: number, z: number) {
  const result = [] as Array<{ x: number, z: number, chunk: any }>
  const target = world.getColumn(x, z)
  if (target) result.push({ x, z, chunk: target })
  const offsets = [-16, 0, 16]
  for (const dx of offsets) {
    for (const dz of offsets) {
      if (dx === 0 && dz === 0) continue
      const nx = x + dx
      const nz = z + dz
      const c = world.getColumn(nx, nz)
      if (c) result.push({ x: nx, z: nz, chunk: c })
    }
  }
  return result
}

function makeEmptyColumnGeometry(sx: number, sy: number, sz: number, sectionHeight: number, hadErrors: boolean): MesherGeometryOutput {
  return {
    sectionYNumber: (sy - (config?.worldMinY || 0)) >> 4,
    chunkKey: worldColumnKey(sx, sz),
    sectionStartY: sy,
    sectionEndY: sy + sectionHeight,
    sectionStartX: sx,
    sectionEndX: sx + 16,
    sectionStartZ: sz,
    sectionEndZ: sz + 16,
    sx: sx + 8,
    sy: sy + 8,
    sz: sz + 8,
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    colors: new Float32Array(0),
    uvs: new Float32Array(0),
    indices: new Uint32Array(0),
    indicesCount: 0,
    using32Array: false,
    tiles: {},
    heads: {},
    signs: {},
    banners: {},
    hadErrors,
    blocksCount: 0,
  }
}

// Full-column meshing path — the sole WASM mesh path.
// It groups dirty section keys by chunk column, runs one WASM call per column
// over the full Y range, then splits the column output back into per-section
// geometries. Only requested section keys are emitted back to the main thread.
function processColumnTick() {
  const worldMinY = config?.worldMinY ?? 0
  const worldMaxY = config?.worldMaxY ?? 256
  const columnHeight = worldMaxY - worldMinY
  const sectionHeight = SECTION_HEIGHT

  // Group dirty sections by chunk column (`${x},${z}` in world block
  // coords — the same units used by section keys). This guarantees a
  // single WASM call per column per tick even when multiple section keys
  // of the same column are dirty.
  const groups = new Map<string, { x: number, z: number, sections: Array<{ key: string, x: number, y: number, z: number, count: number }> }>()
  for (const [key, count] of dirtySections) {
    const [sx, sy, sz] = key.split(',').map(v => parseInt(v, 10))
    const colKey = `${sx},${sz}`
    let g = groups.get(colKey)
    if (!g) {
      g = { x: sx, z: sz, sections: [] }
      groups.set(colKey, g)
    }
    g.sections.push({ key, x: sx, y: sy, z: sz, count })
  }
  dirtySections.clear()

  for (const group of groups.values()) {
    const { x, z, sections } = group
    const targetChunk = world.getColumn(x, z)

    let exportedMap: Map<string, { exported: import('../../three/worldGeometryExport').ExportedSection, blocksCount: number }> | null = null
    let processTime = 0
    let prePhase = 0
    let wasmPhase = 0
    let postPhase = 0
    let preTargetConvert = 0
    let preNeighborConvert = 0
    let preNeighborCount = 0
    let preTypedArrayBuild = 0
    let preOther = 0
    let preCacheHits = 0
    let preCacheMisses = 0
    let hadError = false
    // Outer-scope timestamps so we can finalize `processTime` and
    // `postPhase` AFTER the per-section emit loop runs (the loop builds
    // typed arrays, walks block-entity metadata, and calls postMessage —
    // all of which are part of the worker's real cost and must be
    // attributed to the column).
    let columnStart = 0
    let postStart = 0

    if (targetChunk && wasm) {
      columnStart = performance.now()
      const start = columnStart
      const t0 = start
      try {
        const chunksToUse = collectChunksForColumn(x, z)
        const chunkCount = chunksToUse.length

        let wasmResult: any
        let t1 = 0
        let usedFusedPath = false

        const meta = getBlockMeta(version)

        // ------------------------------------------------------------------
        // Fused fast-path: for single-column meshing (no neighbours), parse
        // and mesh in ONE WASM call so no typed arrays leave Rust memory.
        // Falls back to the old two-step path on any failure.
        // ------------------------------------------------------------------
        if (chunkCount === 1) {
          const rawEntry = rawMapChunkCache.get(rawCacheKey(x, z))
          const v17Entry = parsedV17Cache.get(rawCacheKey(x, z))
          const v16Entry = parsedV16Cache.get(rawCacheKey(x, z))

          if (rawEntry) {
            wasmResult = meshColumnFromRawV18Plus(rawEntry, x, z, worldMinY, worldMaxY, meta)
          } else if (v17Entry) {
            const v17Light = updateLightV17Cache.get(rawCacheKey(x, z))
            wasmResult = meshColumnFromParsedV16V17(
              v17Entry.chunkData, v17Entry.bitMapLoHi, v17Entry.numSections, v17Entry.maxBitsPerBlock,
              v17Entry.biomes, 1,
              v17Light?.skyLight ?? null, v17Light?.blockLight ?? null,
              x, z, worldMinY, worldMaxY, meta
            )
          } else if (v16Entry) {
            const v16Light = updateLightV16Cache.get(rawCacheKey(x, z))
            const bitMapLoHi = new Uint32Array([v16Entry.bitMap >>> 0, 0])
            wasmResult = meshColumnFromParsedV16V17(
              v16Entry.chunkData, bitMapLoHi, 16, 15,
              v16Entry.biomes, 1,
              v16Light?.skyLight ?? null, v16Light?.blockLight ?? null,
              x, z, worldMinY, worldMaxY, meta
            )
          }

          if (wasmResult) {
            usedFusedPath = true
            t1 = performance.now()
            wasmPhase = t1 - t0
            preTargetConvert = wasmPhase
          }
        }

        // ------------------------------------------------------------------
        // Fused multi-column fast-path: parse+mesh all columns in one WASM
        // call with zero JS typed-array allocation.
        // Falls back to the old two-step path when the cache is incomplete
        // or any helper returns null.
        // ------------------------------------------------------------------
        if (!wasmResult && chunkCount > 1) {
          wasmResult = meshMultiColumnsFromRawV18Plus(chunksToUse, x, z, worldMinY, worldMaxY, meta)
                    ?? meshMultiColumnsFromParsedV16V17(chunksToUse, x, z, worldMinY, worldMaxY, meta)
          if (wasmResult) {
            usedFusedPath = true
            t1 = performance.now()
            wasmPhase = t1 - t0
            preTargetConvert = wasmPhase
          }
        }

        if (!wasmResult) {
          // --- Old two-step path (multi-column or fused fallback) ---
          const conversions = chunksToUse.map(({ x: cx, z: cz, chunk }) => {
            const cs = performance.now()
            const rawEntry = rawMapChunkCache.get(rawCacheKey(cx, cz))
            const v17Entry = parsedV17Cache.get(rawCacheKey(cx, cz))
            const v17Light = updateLightV17Cache.get(rawCacheKey(cx, cz))
            const v16Entry = parsedV16Cache.get(rawCacheKey(cx, cz))
            const v16Light = updateLightV16Cache.get(rawCacheKey(cx, cz))

            let conv: ChunkConversionResult | null = null
            let hit = false

            // WASM fast paths — parse is already fast (2.19× over JS), no
            // cache needed.  Bypass getOrConvertColumn so the conversion
            // cache only holds JS-fallback results.  When a WASM helper
            // returns null (unsupported protocol, parser error, …) we MUST
            // fall through to the JS column walk — otherwise the column
            // would render as empty geometry.
            if (rawEntry) {
              conv = convertRawMapChunkToWasm(rawEntry, version)
            } else if (v17Entry) {
              conv = convertParsedV17ToWasm(v17Entry, v17Light, version)
            } else if (v16Entry) {
              conv = convertParsedV16ToWasm(v16Entry, v16Light, version)
            }

            if (!conv) {
              // JS-fallback (column walk) — still cached, since this is the
              // expensive path the conversion cache was built for.
              const cached = getOrConvertColumn(
                cx, cz, chunk, version, worldMinY, worldMaxY,
                () => convertChunkToWasm(chunk, version, cx, cz, worldMinY, worldMaxY),
                chunk
              )
              conv = cached.result
              hit = cached.hit
            }

            const ce = performance.now()
            if (hit) preCacheHits++
            else preCacheMisses++
            if (cx === x && cz === z) {
              preTargetConvert += ce - cs
            } else {
              preNeighborConvert += ce - cs
              preNeighborCount++
            }
            return conv
          })

          const {
            invisibleBlocks,
            transparentBlocks,
            noAoBlocks,
            cullIdenticalBlocks,
            occludingBlocks,
          } = conversions[0]

          if (chunkCount === 1 || !(wasm as any).generate_geometry_multi) {
            const { blockStates, blockLight, skyLight, biomesArray } = conversions[0]
            t1 = performance.now()
            wasmResult = wasm.generate_geometry(
              x, worldMinY, z, columnHeight,
              worldMinY, worldMaxY,
              worldMinY,
              blockStates, blockLight, skyLight, biomesArray,
              invisibleBlocks, transparentBlocks, noAoBlocks, cullIdenticalBlocks, occludingBlocks,
              config?.enableLighting !== false,
              config?.smoothLighting !== false,
              config?.skyLight || 15
            )
          } else {
            const tBuildStart = performance.now()
            const perChunkLen = conversions[0].blockStates.length
            const xs = new Int32Array(chunkCount)
            const zs = new Int32Array(chunkCount)
            const blockStatesAll = new Uint16Array(perChunkLen * chunkCount)
            const blockLightAll = new Uint8Array(perChunkLen * chunkCount)
            const skyLightAll = new Uint8Array(perChunkLen * chunkCount)
            const biomesAll = new Uint8Array(perChunkLen * chunkCount)

            for (let i = 0; i < chunkCount; i++) {
              const c = conversions[i]
              xs[i] = chunksToUse[i].x
              zs[i] = chunksToUse[i].z
              blockStatesAll.set(c.blockStates, perChunkLen * i)
              blockLightAll.set(c.blockLight, perChunkLen * i)
              skyLightAll.set(c.skyLight, perChunkLen * i)
              biomesAll.set(c.biomesArray, perChunkLen * i)
            }
            preTypedArrayBuild = performance.now() - tBuildStart

            t1 = performance.now()
            wasmResult = (wasm as any).generate_geometry_multi(
              x, worldMinY, z, columnHeight,
              worldMinY, worldMaxY,
              worldMinY,
              xs, zs,
              blockStatesAll, blockLightAll, skyLightAll, biomesAll,
              invisibleBlocks, transparentBlocks, noAoBlocks, cullIdenticalBlocks, occludingBlocks,
              config?.enableLighting !== false,
              config?.smoothLighting !== false,
              config?.skyLight || 15
            )
          }
        }

        const t2 = performance.now()
        postStart = t2

        // Split full-column output back into per-section ExportedSection
        // entries — only for the section keys the main thread actually
        // requested. Sections in the column that were NOT requested are
        // intentionally skipped (the request tracker would warn if we
        // emitted sectionFinished for them).
        const requestedSectionKeys = sections.map(s => ({ x: s.x, y: s.y, z: s.z }))
        exportedMap = splitColumnWasmOutputToSections(
          wasmResult,
          requestedSectionKeys,
          { version, world, sectionHeight }
        )

        // Push heightmap from the WASM column output. With column meshing as
        // the only WASM path, the main thread does not request heightmaps
        // explicitly anymore — the worker is the source of truth and pushes
        // a `'heightmap'` message every column tick. Key shape matches the
        // legacy `handleGetHeightmap` contract: `${chunkX>>4},${chunkZ>>4}`.
        const heightmapKey = `${x >> 4},${z >> 4}`
        const wasmHeightmap = extractColumnHeightmap(wasmResult)
        if (wasmHeightmap) {
          postMessage({ type: 'heightmap', key: heightmapKey, heightmap: wasmHeightmap }, [wasmHeightmap.buffer])
        } else {
          console.warn(`[WASM Mesher] heightmap extraction returned null for column ${x},${z}, falling back to JS computeHeightmap`)
          const fallback = handleGetHeightmap(world, x, z)
          postMessage({ type: 'heightmap', key: fallback.key, heightmap: fallback.heightmap }, [fallback.heightmap.buffer])
        }

        if (!usedFusedPath) {
          prePhase = t1 - t0
          wasmPhase = t2 - t1
        }
        preOther = Math.max(0, prePhase - (preTargetConvert + preNeighborConvert + preTypedArrayBuild))
        // NOTE: `postPhase` and `processTime` are finalized AFTER the
        // per-section emit loop below — see the `Finalize column phase
        // numbers` block.
      } catch (err) {
        console.error(`[WASM Mesher] Error processing column ${x},${z}:`, err)
        hadError = true
      }
    }

    // Emit geometry + sectionFinished for each requested section. Column-
    // level perf metrics are attributed to the first sectionFinished of
    // the first requested section (others get zeros) so totals don't
    // double-count.
    //
    // Coherent chunk appearance: column mode relies on the existing
    // `_renderByChunks` / `chunkFinished` contract on the main thread.
    // ChunkMeshManager batches sections per column and reveals them
    // atomically once `WorldRendererCommon` sees the last
    // `sectionFinished` for the column. No dedicated `columnFinished`
    // worker message is needed.
    // Pass 1: build geometry + postMessage for each requested section.
    // We collect finished keys here and emit `sectionFinished` only in
    // Pass 2 below, after `postPhase` / `processTime` have been
    // finalized — otherwise the totals attached to the first event
    // would miss the typed-array allocation, block-entity walk, and
    // postMessage cost of every section in this column.
    const finished: Array<{ key: string, count: number }> = []
    for (const s of sections) {
      const { key, x: sx, y: sy, z: sz, count } = s

      if (exportedMap && !hadError) {
        const entry = exportedMap.get(key)
        const exported = entry?.exported
        const sectionBlocksCount = entry?.blocksCount ?? 0
        // Block entity metadata still needs a per-section world walk
        // (signs/heads/banners), matching the legacy per-section path.
        const signs: Record<string, SignMeta> = {}
        const heads: Record<string, HeadMeta> = {}
        const banners: Record<string, BannerMeta> = {}
        const beTarget = { signs, heads, banners }
        const beOpts = { disableBlockEntityTextures: world.config.disableBlockEntityTextures }
        const cursor = new Vec3(0, 0, 0)
        for (cursor.y = sy; cursor.y < sy + sectionHeight; cursor.y++) {
          for (cursor.z = sz; cursor.z < sz + 16; cursor.z++) {
            for (cursor.x = sx; cursor.x < sx + 16; cursor.x++) {
              const b = world.getBlock(cursor)
              if (!b) continue
              collectBlockEntityMetadata(b, cursor.x, cursor.y, cursor.z, beTarget, beOpts)
            }
          }
        }

        let geometry: MesherGeometryOutput
        let transferable: any[] = []
        if (exported && exported.geometry.indices.length > 0) {
          const maxIndex = exported.geometry.indices.length > 0
            ? Math.max(...exported.geometry.indices)
            : 0
          const using32Array = maxIndex > 65535
          geometry = {
            sectionYNumber: (sy - (config?.worldMinY || 0)) >> 4,
            chunkKey: worldColumnKey(sx, sz),
            sectionStartY: sy,
            sectionEndY: sy + sectionHeight,
            sectionStartX: sx,
            sectionEndX: sx + 16,
            sectionStartZ: sz,
            sectionEndZ: sz + 16,
            sx: sx + 8,
            sy: sy + 8,
            sz: sz + 8,
            positions: new Float32Array(exported.geometry.positions),
            normals: new Float32Array(exported.geometry.normals),
            colors: new Float32Array(exported.geometry.colors),
            uvs: new Float32Array(exported.geometry.uvs),
            indices: using32Array
              ? new Uint32Array(exported.geometry.indices)
              : new Uint16Array(exported.geometry.indices),
            indicesCount: exported.geometry.indices.length,
            using32Array,
            tiles: {},
            heads,
            signs,
            banners,
            hadErrors: false,
            // Per-section block bucket size from the column split. The
            // field is informational (used by `chunkMeshManager` for the
            // `B:` debug overlay stat) and matches the per-section path's
            // semantics: number of blocks that contributed faces to this
            // section's geometry.
            blocksCount: sectionBlocksCount,
          }
          transferable = [
            geometry.positions?.buffer,
            geometry.normals?.buffer,
            geometry.colors?.buffer,
            geometry.uvs?.buffer,
            //@ts-ignore
            geometry.indices?.buffer,
          ].filter(Boolean)

          if (exported.geometry.indices.length > 0 && config.computeWireframeEdges) {
            try {
              const wireframeF32 = geometry.indices instanceof Uint32Array
                ? wasm!.computeWireframeEdges(geometry.positions as Float32Array, geometry.indices)
                : wasm!.computeWireframeEdgesU16(geometry.positions as Float32Array, geometry.indices as Uint16Array)
              if (wireframeF32.length > 0) {
                geometry.wireframePositions = wireframeF32
                transferable.push(wireframeF32.buffer)
              }
            } catch (err) {
              // Fall through — sciFiWorldReveal will fall back to main-thread computation
            }
          }
        } else {
          geometry = makeEmptyColumnGeometry(sx, sy, sz, sectionHeight, false)
          // Still attach block entity metadata so the main thread sees
          // signs/heads/banners even for empty-mesh sections.
          geometry.signs = signs
          geometry.heads = heads
          geometry.banners = banners
        }
        postMessage({ type: 'geometry', key, geometry, workerIndex }, transferable)
      } else if (hadError) {
        const errorGeometry = makeEmptyColumnGeometry(sx, sy, sz, sectionHeight, true)
        postMessage({ type: 'geometry', key, geometry: errorGeometry, workerIndex })
      }
      // No targetChunk and no error: skip geometry message (mirrors
      // legacy behavior for sections whose chunk has been unloaded
      // mid-tick) but still emit sectionFinished below so the main
      // thread's sectionsWaiting counter unblocks.
      finished.push({ key, count })
    }

    // Finalize column phase numbers — now they include split + per-
    // section typed-array build + block-entity walk + geometry
    // postMessage cost.
    if (columnStart > 0 && !hadError) {
      const tEnd = performance.now()
      if (postStart > 0) postPhase = tEnd - postStart
      processTime = tEnd - columnStart
    }

    // Pass 2: emit sectionFinished events. Column-level perf metrics
    // are attributed to the first emitted sectionFinished (others get
    // zeros) so totals don't double-count.
    let attributed = false
    for (const { key, count } of finished) {
      for (let i = 0; i < count; i++) {
        emitSectionFinished({
          type: 'sectionFinished',
          key,
          workerIndex,
          processTime: !attributed ? processTime : 0,
          pre: !attributed ? prePhase : 0,
          wasm: !attributed ? wasmPhase : 0,
          post: !attributed ? postPhase : 0,
          preTargetConvert: !attributed ? preTargetConvert : 0,
          preNeighborConvert: !attributed ? preNeighborConvert : 0,
          preNeighborCount: !attributed ? preNeighborCount : 0,
          preTypedArrayBuild: !attributed ? preTypedArrayBuild : 0,
          preOther: !attributed ? preOther : 0,
          preCacheHits: !attributed ? preCacheHits : 0,
          preCacheMisses: !attributed ? preCacheMisses : 0,
        })
        attributed = true
      }
    }
  }
}

setInterval(async () => {
  if (!allDataReady) return

  // Ensure WASM is initialized
  if (!wasmInitialized) {
    await initWasm()
    if (!wasmInitialized) return // Still not initialized, skip this cycle
  }

  if (dirtySections.size === 0) return

  try {
    processColumnTick()
  } catch (err) {
    console.error('[WASM Mesher] processColumnTick failed:', err)
    // Swallow to avoid breaking the setInterval; individual columns
    // already have their own try/catch.
  }
}, 50)
