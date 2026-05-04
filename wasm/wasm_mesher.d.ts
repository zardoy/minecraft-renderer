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
