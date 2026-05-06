/* tslint:disable */
/* eslint-disable */

/**
 * VITALY's path: parse 1.18+ dump + light → run the mesher → return ONLY the final
 * geometry. Avoids marshalling the intermediate ~300KB block_states/biomes/lights
 * arrays back to JS.
 *
 * Combines `parseChunkDump118FullColumnAll` and `generate_geometry` into one Rust call.
 * All `generate_geometry` parameters (mesher config, block-state lists) are accepted
 * unchanged.
 */
export function generateGeometryFromDump118(section_x: number, section_y: number, section_z: number, section_height: number, world_min_y: number, world_max_y: number, section_data_start_y: number, dump_buffer: Uint8Array, sky_light_concat: Uint8Array, block_light_concat: Uint8Array, sky_light_mask: Uint32Array, block_light_mask: Uint32Array, empty_sky_light_mask: Uint32Array, empty_block_light_mask: Uint32Array, num_sections: number, max_bits_per_block: number, max_bits_per_biome: number, invisible_blocks: Uint16Array, transparent_blocks: Uint16Array, no_ao_blocks: Uint16Array, cull_identical_blocks: Uint16Array, occluding_blocks: Uint16Array, enable_lighting: boolean, smooth_lighting: boolean, sky_light_value: number): any;

/**
 * Main entry point for generating geometry
 *
 * Input: Serialized chunk data as TypedArrays
 * Output: Geometry data (positions, normals, colors, uvs, indices)
 */
export function generate_geometry(section_x: number, section_y: number, section_z: number, section_height: number, world_min_y: number, world_max_y: number, section_data_start_y: number, block_states: Uint16Array, block_light: Uint8Array, sky_light: Uint8Array, biomes: Uint8Array, invisible_blocks: Uint16Array, transparent_blocks: Uint16Array, no_ao_blocks: Uint16Array, cull_identical_blocks: Uint16Array, occluding_blocks: Uint16Array, enable_lighting: boolean, smooth_lighting: boolean, sky_light_value: number): any;

export function generate_geometry_multi(section_x: number, section_y: number, section_z: number, section_height: number, world_min_y: number, world_max_y: number, section_data_start_y: number, chunk_xs: Int32Array, chunk_zs: Int32Array, block_states: Uint16Array, block_light: Uint8Array, sky_light: Uint8Array, biomes: Uint8Array, invisible_blocks: Uint16Array, transparent_blocks: Uint16Array, no_ao_blocks: Uint16Array, cull_identical_blocks: Uint16Array, occluding_blocks: Uint16Array, enable_lighting: boolean, smooth_lighting: boolean, sky_light_value: number): any;

/**
 * Parse a 1.18+ Minecraft chunk dump (column.dump() output).
 *
 * Returns an object: { blockStates: Uint16Array, biomes: Uint8Array, bytesRead: number }.
 * Throws on parse error.
 */
export function parseChunkDump118(buffer: Uint8Array, num_sections: number, max_bits_per_block: number, max_bits_per_biome: number): any;

/**
 *   index = x + z*16 + y*256, where y goes 0..(num_sections*16).
 * Biomes are expanded from per-section 4×4×4 to per-block (matching prismarine-chunk's
 * `getBiome(pos)`).
 *
 * This is the drop-in replacement for `convertChunkToWasm`'s blocks+biomes extraction:
 * no JS hot loop, no per-section-to-full-column reorder. Light is still produced by
 * `unpackLightSection118` per section (caller is responsible).
 *
 * Returns: { blockStates: Uint16Array, biomes: Uint8Array, bytesRead: number }.
 */
export function parseChunkDump118FullColumn(buffer: Uint8Array, num_sections: number, max_bits_per_block: number, max_bits_per_biome: number): any;

/**
 * Full drop-in replacement for `convertChunkToWasm`: parses dump + assembles light into
 * `convertChunkToWasm`-shaped Uint16Array(blocks) + Uint8Array(biomes/blockLight/skyLight).
 *
 * Light masks come as Uint32Array laid out as (low0, high0, low1, high1, ...).
 * The JS side flattens prismarine's [[high, low]] format into that order:
 *   `Uint32Array.of(...mask.flatMap(([h, l]) => [l >>> 0, h >>> 0]))`.
 *
 * `sky_light_concat` / `block_light_concat` = concatenation of present light section
 * buffers (each 2048 bytes), in mask-bit order (border-below first).
 *
 * Returns: { blockStates: Uint16Array, biomes: Uint8Array, blockLight: Uint8Array,
 *            skyLight: Uint8Array, bytesRead: number }.
 */
export function parseChunkDump118FullColumnAll(dump_buffer: Uint8Array, sky_light_concat: Uint8Array, block_light_concat: Uint8Array, sky_light_mask: Uint32Array, block_light_mask: Uint32Array, empty_sky_light_mask: Uint32Array, empty_block_light_mask: Uint32Array, num_sections: number, max_bits_per_block: number, max_bits_per_biome: number): any;

/**
 * PoC bench helper: parse dump but return ONLY a checksum (no Uint16Array marshalling).
 * Lets us isolate raw parse cost from the JS<->WASM boundary cost.
 */
export function parseChunkDump118NoMarshal(buffer: Uint8Array, num_sections: number, max_bits_per_block: number, max_bits_per_biome: number): number;

/**
 * Parse a 1.17 chunk-section payload (the bytes inside `chunkData` of a
 * `map_chunk` packet) into a flat `Uint16Array` of block states **and** an
 * expanded per-block biome `Uint8Array`.
 *
 * `chunk_data` — exactly the bytes between the `chunkData` length prefix and
 * the `blockEntities` count in the wire packet (i.e. what
 * `prismarine-chunk` 1.17 `ChunkColumn.load(data, bitMap)` consumes). The
 * JS-side caller (mineflayer/protodef) does the outer-packet parsing and
 * hands the slice in directly.
 *
 * `bit_map_lo_hi` — section mask flattened to `[low0, high0, low1, high1,
 * ...]` u32 pairs. Bit `s` indicates that section index `s` is present in
 * `chunk_data`. Sections without a set bit decode to all-zeros.
 *
 * `biomes_cells` — the 1.17 wire `biomes` field (varint[num_sections * 64]),
 * passed straight through as `Int32Array`. May be empty (`&[]`) when the
 * caller didn't capture biomes — every block then gets `default_biome`
 * (typically 1 = plains).
 *
 * Returns `{ blockStates: Uint16Array(num_sections * 4096),
 *            biomes: Uint8Array(num_sections * 4096),
 *            bytesRead, bytesTotal }`.
 * Layout of both arrays is `(s * 4096) | (y_in << 8) | (z << 4) | x`,
 * matching what the WASM mesher already consumes for 1.18+ blocks.
 *
 * Light is **not** produced here — in 1.17 it arrives in a separate
 * `update_light` packet (see `parseUpdateLightV17`). The JS bridge fills in
 * defaults (sky=15, block=0) or merges real data from a paired light cache.
 */
export function parseChunkSectionsV17(chunk_data: Uint8Array, bit_map_lo_hi: Uint32Array, num_sections: number, max_bits_per_block: number, biomes_cells: Int32Array, default_biome: number): any;

/**
 * Stage-3 entry: parse a raw `map_chunk` packet (1.18+) into the same shape as
 * `parseChunkDump118FullColumnAll` so the worker can drop it straight into
 * `generate_geometry`.
 *
 * `raw_packet` is the buffer captured from `bot._client.on('raw.map_chunk', ...)`;
 * it includes the leading packet-id varint (we skip it). `protocol` selects
 * the version-specific quirks (heightmaps NBT, trust_edges, anonymous NBT, etc.).
 *
 * Returns: `{ x, z, blockStates: Uint16Array, biomes: Uint8Array,
 *             blockLight: Uint8Array, skyLight: Uint8Array, bytesRead }`.
 */
export function parseMapChunkV18Plus(raw_packet: Uint8Array, num_sections: number, max_bits_per_block: number, max_bits_per_biome: number, protocol: number): any;

/**
 * Parse a raw 1.17 `update_light` packet (as captured by
 * `client.on('raw.update_light', ...)`) into flat per-block sky/block light
 * arrays the WASM mesher consumes.
 *
 * `raw_packet` includes the leading packet-id varint (we skip it).
 * `num_sections` should match the column the light is for (16 in 1.17).
 *
 * Returns `{ x, z, skyLight: Uint8Array(num_sections * 4096),
 *            blockLight: Uint8Array(num_sections * 4096), bytesRead }`.
 * Layout matches the existing 1.18+ light arrays
 * (`x + z*16 + y_abs*256`); the JS-side worker reorders into per-section
 * stack via the same path used for 1.18+ raw map_chunk parsing.
 */
export function parseUpdateLightV17(raw_packet: Uint8Array, num_sections: number): any;

/**
 * Unpack a single light section (2048 bytes, BitArrayNoSpan bpv=4) into 4096 nibble values.
 */
export function unpackLightSection118(buffer: Uint8Array): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly generate_geometry: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number, a1: number, b1: number) => any;
  readonly generate_geometry_multi: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number, a1: number, b1: number, c1: number, d1: number, e1: number, f1: number) => any;
  readonly parseChunkDump118: (a: number, b: number, c: number, d: number, e: number) => any;
  readonly unpackLightSection118: (a: number, b: number) => [number, number];
  readonly parseChunkDump118NoMarshal: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly parseChunkDump118FullColumnAll: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number) => any;
  readonly generateGeometryFromDump118: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number, a1: number, b1: number, c1: number, d1: number, e1: number, f1: number, g1: number, h1: number, i1: number, j1: number, k1: number) => any;
  readonly parseChunkDump118FullColumn: (a: number, b: number, c: number, d: number, e: number) => any;
  readonly parseMapChunkV18Plus: (a: number, b: number, c: number, d: number, e: number, f: number) => any;
  readonly parseChunkSectionsV17: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => any;
  readonly parseUpdateLightV17: (a: number, b: number, c: number) => any;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
