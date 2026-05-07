/**
 * Shared WorldView types used by both main thread and mesher worker.
 */

import { Vec3 } from 'vec3'

/** Chunk position key format: "x,z" e.g. "16,16" */
export type ChunkPosKey = string

/** Chunk position object */
export type ChunkPos = { x: number; z: number }

/** World size parameters sent with chunk data */
export interface WorldSizeParams {
  minY: number
  worldHeight: number
}

/** Block update event data */
export interface BlockUpdateData {
  pos: Vec3
  stateId: number
}

/** Chunk load event data */
export interface LoadChunkData {
  x: number
  z: number
  chunk: string
  blockEntities: any
  worldConfig: WorldSizeParams
  isLightUpdate: boolean
}

/** Chunk unload event data */
export interface UnloadChunkData {
  x: number
  z: number
}

/**
 * Raw `map_chunk` packet payload forwarded to the WASM mesher worker.
 * Stage 3 of issue-15-wasm — lets the worker call `parseMapChunkV18Plus`
 * directly on the bytes mineflayer received, bypassing the JS hot loop
 * `convertChunkToWasm` for protocol >= 757 (1.18+).
 */
export interface RawMapChunkData {
  x: number
  z: number
  rawPacket: Uint8Array
  protocol: number
  numSections: number
}

/**
 * Pre-parsed `map_chunk` payload for protocol 756 (1.17/1.17.1).
 * The 1.17 wire format is split across two packets (`map_chunk` for
 * blocks/biomes/heightmaps and `update_light` for lighting), so we feed the
 * WASM parser only the section bytes plus the bit-mask. Mineflayer already
 * does the cheap top-level parsing for us; we just hand the
 * already-extracted `chunkData` and `bitMap` to the worker.
 */
export interface ParsedMapChunkV17Data {
  x: number
  z: number
  protocol: number
  numSections: number
  maxBitsPerBlock: number
  chunkData: Uint8Array
  /** Section bit mask flattened as [lo0, hi0, lo1, hi1, ...] u32 pairs. */
  bitMapLoHi: Uint32Array
  /** Optional flat biomes (1024 entries, 4×4×4 cells per column). */
  biomes?: Int32Array
}

/**
 * Raw `update_light` payload for protocol 755/756 (1.17/1.17.1). The
 * worker decodes (chunkX, chunkZ) out of the varints in `rawPacket` via
 * `parseUpdateLightV17` — JS doesn't peek at coords, so the packet bytes
 * are forwarded verbatim (with the leading packet-id varint included).
 */
export interface UpdateLightV17Data {
  protocol: number
  numSections: number
  rawPacket: Uint8Array
}

/**
 * Pre-parsed `map_chunk` payload for the 1.16.x family (protocols
 * 735, 736, 751, 753, 754). Wire format for chunk sections is identical
 * to 1.17, so the worker reuses `parseChunkSectionsV16V17`. The bit mask
 * is a single varint in 1.16 (only 16 sections), forwarded as a plain
 * number; the worker widens it to a [lo,hi] u32 pair.
 */
export interface ParsedMapChunkV16Data {
  x: number
  z: number
  protocol: number
  chunkData: Uint8Array
  bitMap: number
  /** Flat 1024-entry biome cells (4×4×4 per column). */
  biomes: Int32Array
}

/**
 * Raw `update_light` payload for the 1.16.x family. Same wire format as
 * 1.17, so the worker calls `parseUpdateLightV17` on the bytes; the
 * result lands in a separate v16 light cache to keep the two protocol
 * families isolated.
 */
export interface UpdateLightV16Data {
  x: number
  z: number
  protocol: number
  rawPacket: Uint8Array
}

/** Biome update event data */
export interface BiomeUpdateData {
  biome: any
}

/**
 * Discriminated union forwarded to the WASM mesher workers via the
 * `feedChunkPacket` backend method. `kind` matches the worker message
 * `type` so the backend method can forward the payload verbatim to
 * `worker.postMessage`.
 */
export type FeedChunkPacketPayload =
  | ({ kind: 'setRawMapChunk' } & RawMapChunkData)
  | ({ kind: 'setParsedMapChunkV17' } & ParsedMapChunkV17Data)
  | ({ kind: 'setUpdateLightV17' } & UpdateLightV17Data)
  | ({ kind: 'setParsedMapChunkV16' } & ParsedMapChunkV16Data)
  | ({ kind: 'setUpdateLightV16' } & UpdateLightV16Data)

/**
 * WorldView events emitted to the renderer.
 */
export type WorldViewEvents = {
  chunkPosUpdate: (data: { pos: Vec3 }) => void
  blockUpdate: (data: BlockUpdateData) => void
  entity: (data: any) => void
  entityMoved: (data: any) => void
  playerEntity: (data: any) => void
  time: (data: number) => void
  renderDistance: (viewDistance: number) => void
  blockEntities: (data: Record<string, any> | { blockEntities: Record<string, any> }) => void
  markAsLoaded: (data: ChunkPos) => void
  unloadChunk: (data: UnloadChunkData) => void
  loadChunk: (data: LoadChunkData) => void
  updateLight: (data: { pos: Vec3 }) => void
  onWorldSwitch: () => void
  end: () => void
  biomeUpdate: (data: BiomeUpdateData) => void
  biomeReset: () => void
}
