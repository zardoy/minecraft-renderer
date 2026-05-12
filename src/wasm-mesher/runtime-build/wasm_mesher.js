let wasm;

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayU16FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint16ArrayMemory0().subarray(ptr / 2, ptr / 2 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint16ArrayMemory0 = null;
function getUint16ArrayMemory0() {
    if (cachedUint16ArrayMemory0 === null || cachedUint16ArrayMemory0.byteLength === 0) {
        cachedUint16ArrayMemory0 = new Uint16Array(wasm.memory.buffer);
    }
    return cachedUint16ArrayMemory0;
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function passArray16ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 2, 2) >>> 0;
    getUint16ArrayMemory0().set(arg, ptr / 2);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    }
}

let WASM_VECTOR_LEN = 0;

/**
 * VITALY's path: parse 1.18+ dump + light → run the mesher → return ONLY the final
 * geometry. Avoids marshalling the intermediate ~300KB block_states/biomes/lights
 * arrays back to JS.
 *
 * Combines `parseChunkDump118FullColumnAll` and `generate_geometry` into one Rust call.
 * All `generate_geometry` parameters (mesher config, block-state lists) are accepted
 * unchanged.
 * @param {number} section_x
 * @param {number} section_y
 * @param {number} section_z
 * @param {number} section_height
 * @param {number} world_min_y
 * @param {number} world_max_y
 * @param {number} section_data_start_y
 * @param {Uint8Array} dump_buffer
 * @param {Uint8Array} sky_light_concat
 * @param {Uint8Array} block_light_concat
 * @param {Uint32Array} sky_light_mask
 * @param {Uint32Array} block_light_mask
 * @param {Uint32Array} empty_sky_light_mask
 * @param {Uint32Array} empty_block_light_mask
 * @param {number} num_sections
 * @param {number} max_bits_per_block
 * @param {number} max_bits_per_biome
 * @param {Uint16Array} invisible_blocks
 * @param {Uint16Array} transparent_blocks
 * @param {Uint16Array} no_ao_blocks
 * @param {Uint16Array} cull_identical_blocks
 * @param {Uint16Array} occluding_blocks
 * @param {boolean} enable_lighting
 * @param {boolean} smooth_lighting
 * @param {number} sky_light_value
 * @returns {any}
 */
export function generateGeometryFromDump118(section_x, section_y, section_z, section_height, world_min_y, world_max_y, section_data_start_y, dump_buffer, sky_light_concat, block_light_concat, sky_light_mask, block_light_mask, empty_sky_light_mask, empty_block_light_mask, num_sections, max_bits_per_block, max_bits_per_biome, invisible_blocks, transparent_blocks, no_ao_blocks, cull_identical_blocks, occluding_blocks, enable_lighting, smooth_lighting, sky_light_value) {
    const ptr0 = passArray8ToWasm0(dump_buffer, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(sky_light_concat, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(block_light_concat, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray32ToWasm0(sky_light_mask, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArray32ToWasm0(block_light_mask, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passArray32ToWasm0(empty_sky_light_mask, wasm.__wbindgen_malloc);
    const len5 = WASM_VECTOR_LEN;
    const ptr6 = passArray32ToWasm0(empty_block_light_mask, wasm.__wbindgen_malloc);
    const len6 = WASM_VECTOR_LEN;
    const ptr7 = passArray16ToWasm0(invisible_blocks, wasm.__wbindgen_malloc);
    const len7 = WASM_VECTOR_LEN;
    const ptr8 = passArray16ToWasm0(transparent_blocks, wasm.__wbindgen_malloc);
    const len8 = WASM_VECTOR_LEN;
    const ptr9 = passArray16ToWasm0(no_ao_blocks, wasm.__wbindgen_malloc);
    const len9 = WASM_VECTOR_LEN;
    const ptr10 = passArray16ToWasm0(cull_identical_blocks, wasm.__wbindgen_malloc);
    const len10 = WASM_VECTOR_LEN;
    const ptr11 = passArray16ToWasm0(occluding_blocks, wasm.__wbindgen_malloc);
    const len11 = WASM_VECTOR_LEN;
    const ret = wasm.generateGeometryFromDump118(section_x, section_y, section_z, section_height, world_min_y, world_max_y, section_data_start_y, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, num_sections, max_bits_per_block, max_bits_per_biome, ptr7, len7, ptr8, len8, ptr9, len9, ptr10, len10, ptr11, len11, enable_lighting, smooth_lighting, sky_light_value);
    return ret;
}

/**
 * Main entry point for generating geometry
 *
 * Input: Serialized chunk data as TypedArrays
 * Output: Geometry data (positions, normals, colors, uvs, indices)
 * @param {number} section_x
 * @param {number} section_y
 * @param {number} section_z
 * @param {number} section_height
 * @param {number} world_min_y
 * @param {number} world_max_y
 * @param {number} section_data_start_y
 * @param {Uint16Array} block_states
 * @param {Uint8Array} block_light
 * @param {Uint8Array} sky_light
 * @param {Uint8Array} biomes
 * @param {Uint16Array} invisible_blocks
 * @param {Uint16Array} transparent_blocks
 * @param {Uint16Array} no_ao_blocks
 * @param {Uint16Array} cull_identical_blocks
 * @param {Uint16Array} occluding_blocks
 * @param {boolean} enable_lighting
 * @param {boolean} smooth_lighting
 * @param {number} sky_light_value
 * @returns {any}
 */
export function generate_geometry(section_x, section_y, section_z, section_height, world_min_y, world_max_y, section_data_start_y, block_states, block_light, sky_light, biomes, invisible_blocks, transparent_blocks, no_ao_blocks, cull_identical_blocks, occluding_blocks, enable_lighting, smooth_lighting, sky_light_value) {
    const ptr0 = passArray16ToWasm0(block_states, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(block_light, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(sky_light, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(biomes, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArray16ToWasm0(invisible_blocks, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passArray16ToWasm0(transparent_blocks, wasm.__wbindgen_malloc);
    const len5 = WASM_VECTOR_LEN;
    const ptr6 = passArray16ToWasm0(no_ao_blocks, wasm.__wbindgen_malloc);
    const len6 = WASM_VECTOR_LEN;
    const ptr7 = passArray16ToWasm0(cull_identical_blocks, wasm.__wbindgen_malloc);
    const len7 = WASM_VECTOR_LEN;
    const ptr8 = passArray16ToWasm0(occluding_blocks, wasm.__wbindgen_malloc);
    const len8 = WASM_VECTOR_LEN;
    const ret = wasm.generate_geometry(section_x, section_y, section_z, section_height, world_min_y, world_max_y, section_data_start_y, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, ptr8, len8, enable_lighting, smooth_lighting, sky_light_value);
    return ret;
}

/**
 * @param {number} section_x
 * @param {number} section_y
 * @param {number} section_z
 * @param {number} section_height
 * @param {number} world_min_y
 * @param {number} world_max_y
 * @param {number} section_data_start_y
 * @param {Int32Array} chunk_xs
 * @param {Int32Array} chunk_zs
 * @param {Uint16Array} block_states
 * @param {Uint8Array} block_light
 * @param {Uint8Array} sky_light
 * @param {Uint8Array} biomes
 * @param {Uint16Array} invisible_blocks
 * @param {Uint16Array} transparent_blocks
 * @param {Uint16Array} no_ao_blocks
 * @param {Uint16Array} cull_identical_blocks
 * @param {Uint16Array} occluding_blocks
 * @param {boolean} enable_lighting
 * @param {boolean} smooth_lighting
 * @param {number} sky_light_value
 * @returns {any}
 */
export function generate_geometry_multi(section_x, section_y, section_z, section_height, world_min_y, world_max_y, section_data_start_y, chunk_xs, chunk_zs, block_states, block_light, sky_light, biomes, invisible_blocks, transparent_blocks, no_ao_blocks, cull_identical_blocks, occluding_blocks, enable_lighting, smooth_lighting, sky_light_value) {
    const ptr0 = passArray32ToWasm0(chunk_xs, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(chunk_zs, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray16ToWasm0(block_states, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(block_light, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArray8ToWasm0(sky_light, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passArray8ToWasm0(biomes, wasm.__wbindgen_malloc);
    const len5 = WASM_VECTOR_LEN;
    const ptr6 = passArray16ToWasm0(invisible_blocks, wasm.__wbindgen_malloc);
    const len6 = WASM_VECTOR_LEN;
    const ptr7 = passArray16ToWasm0(transparent_blocks, wasm.__wbindgen_malloc);
    const len7 = WASM_VECTOR_LEN;
    const ptr8 = passArray16ToWasm0(no_ao_blocks, wasm.__wbindgen_malloc);
    const len8 = WASM_VECTOR_LEN;
    const ptr9 = passArray16ToWasm0(cull_identical_blocks, wasm.__wbindgen_malloc);
    const len9 = WASM_VECTOR_LEN;
    const ptr10 = passArray16ToWasm0(occluding_blocks, wasm.__wbindgen_malloc);
    const len10 = WASM_VECTOR_LEN;
    const ret = wasm.generate_geometry_multi(section_x, section_y, section_z, section_height, world_min_y, world_max_y, section_data_start_y, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, ptr8, len8, ptr9, len9, ptr10, len10, enable_lighting, smooth_lighting, sky_light_value);
    return ret;
}

/**
 * Parse a 1.18+ Minecraft chunk dump (column.dump() output).
 *
 * Returns an object: { blockStates: Uint16Array, biomes: Uint8Array, bytesRead: number }.
 * Throws on parse error.
 * @param {Uint8Array} buffer
 * @param {number} num_sections
 * @param {number} max_bits_per_block
 * @param {number} max_bits_per_biome
 * @returns {any}
 */
export function parseChunkDump118(buffer, num_sections, max_bits_per_block, max_bits_per_biome) {
    const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parseChunkDump118(ptr0, len0, num_sections, max_bits_per_block, max_bits_per_biome);
    return ret;
}

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
 * @param {Uint8Array} buffer
 * @param {number} num_sections
 * @param {number} max_bits_per_block
 * @param {number} max_bits_per_biome
 * @returns {any}
 */
export function parseChunkDump118FullColumn(buffer, num_sections, max_bits_per_block, max_bits_per_biome) {
    const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parseChunkDump118FullColumn(ptr0, len0, num_sections, max_bits_per_block, max_bits_per_biome);
    return ret;
}

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
 * @param {Uint8Array} dump_buffer
 * @param {Uint8Array} sky_light_concat
 * @param {Uint8Array} block_light_concat
 * @param {Uint32Array} sky_light_mask
 * @param {Uint32Array} block_light_mask
 * @param {Uint32Array} empty_sky_light_mask
 * @param {Uint32Array} empty_block_light_mask
 * @param {number} num_sections
 * @param {number} max_bits_per_block
 * @param {number} max_bits_per_biome
 * @returns {any}
 */
export function parseChunkDump118FullColumnAll(dump_buffer, sky_light_concat, block_light_concat, sky_light_mask, block_light_mask, empty_sky_light_mask, empty_block_light_mask, num_sections, max_bits_per_block, max_bits_per_biome) {
    const ptr0 = passArray8ToWasm0(dump_buffer, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(sky_light_concat, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(block_light_concat, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray32ToWasm0(sky_light_mask, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArray32ToWasm0(block_light_mask, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passArray32ToWasm0(empty_sky_light_mask, wasm.__wbindgen_malloc);
    const len5 = WASM_VECTOR_LEN;
    const ptr6 = passArray32ToWasm0(empty_block_light_mask, wasm.__wbindgen_malloc);
    const len6 = WASM_VECTOR_LEN;
    const ret = wasm.parseChunkDump118FullColumnAll(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, num_sections, max_bits_per_block, max_bits_per_biome);
    return ret;
}

/**
 * PoC bench helper: parse dump but return ONLY a checksum (no Uint16Array marshalling).
 * Lets us isolate raw parse cost from the JS<->WASM boundary cost.
 * @param {Uint8Array} buffer
 * @param {number} num_sections
 * @param {number} max_bits_per_block
 * @param {number} max_bits_per_biome
 * @returns {number}
 */
export function parseChunkDump118NoMarshal(buffer, num_sections, max_bits_per_block, max_bits_per_biome) {
    const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parseChunkDump118NoMarshal(ptr0, len0, num_sections, max_bits_per_block, max_bits_per_biome);
    return ret;
}

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
 * @param {Uint8Array} chunk_data
 * @param {Uint32Array} bit_map_lo_hi
 * @param {number} num_sections
 * @param {number} max_bits_per_block
 * @param {Int32Array} biomes_cells
 * @param {number} default_biome
 * @returns {any}
 */
export function parseChunkSectionsV16V17(chunk_data, bit_map_lo_hi, num_sections, max_bits_per_block, biomes_cells, default_biome) {
    const ptr0 = passArray8ToWasm0(chunk_data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(bit_map_lo_hi, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray32ToWasm0(biomes_cells, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.parseChunkSectionsV16V17(ptr0, len0, ptr1, len1, num_sections, max_bits_per_block, ptr2, len2, default_biome);
    return ret;
}

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
 * @param {Uint8Array} raw_packet
 * @param {number} num_sections
 * @param {number} max_bits_per_block
 * @param {number} max_bits_per_biome
 * @param {number} protocol
 * @returns {any}
 */
export function parseMapChunkV18Plus(raw_packet, num_sections, max_bits_per_block, max_bits_per_biome, protocol) {
    const ptr0 = passArray8ToWasm0(raw_packet, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parseMapChunkV18Plus(ptr0, len0, num_sections, max_bits_per_block, max_bits_per_biome, protocol);
    return ret;
}

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
 * @param {Uint8Array} raw_packet
 * @param {number} num_sections
 * @returns {any}
 */
export function parseUpdateLightV17(raw_packet, num_sections) {
    const ptr0 = passArray8ToWasm0(raw_packet, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parseUpdateLightV17(ptr0, len0, num_sections);
    return ret;
}

/**
 * Unpack a single light section (2048 bytes, BitArrayNoSpan bpv=4) into 4096 nibble values.
 * @param {Uint8Array} buffer
 * @returns {Uint8Array}
 */
export function unpackLightSection118(buffer) {
    const ptr0 = passArray8ToWasm0(buffer, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.unpackLightSection118(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

const EXPECTED_RESPONSE_TYPES = new Set(['basic', 'cors', 'default']);

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && EXPECTED_RESPONSE_TYPES.has(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};
    imports.wbg.__wbg_Error_52673b7de5a0ca89 = function(arg0, arg1) {
        const ret = Error(getStringFromWasm0(arg0, arg1));
        return ret;
    };
    imports.wbg.__wbg___wbindgen_debug_string_adfb662ae34724b6 = function(arg0, arg1) {
        const ret = debugString(arg1);
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg___wbindgen_throw_dd24417ed36fc46e = function(arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
    };
    imports.wbg.__wbg_length_22ac23eaec9d8053 = function(arg0) {
        const ret = arg0.length;
        return ret;
    };
    imports.wbg.__wbg_length_497fc8f401ac8b1c = function(arg0) {
        const ret = arg0.length;
        return ret;
    };
    imports.wbg.__wbg_new_1ba21ce319a06297 = function() {
        const ret = new Object();
        return ret;
    };
    imports.wbg.__wbg_new_25f239778d6112b9 = function() {
        const ret = new Array();
        return ret;
    };
    imports.wbg.__wbg_new_with_length_aa5eaf41d35235e5 = function(arg0) {
        const ret = new Uint8Array(arg0 >>> 0);
        return ret;
    };
    imports.wbg.__wbg_new_with_length_d7142aa2b68069a8 = function(arg0) {
        const ret = new Uint16Array(arg0 >>> 0);
        return ret;
    };
    imports.wbg.__wbg_set_169e13b608078b7b = function(arg0, arg1, arg2) {
        arg0.set(getArrayU8FromWasm0(arg1, arg2));
    };
    imports.wbg.__wbg_set_3f1d0b984ed272ed = function(arg0, arg1, arg2) {
        arg0[arg1] = arg2;
    };
    imports.wbg.__wbg_set_781438a03c0c3c81 = function() { return handleError(function (arg0, arg1, arg2) {
        const ret = Reflect.set(arg0, arg1, arg2);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_set_7df433eea03a5c14 = function(arg0, arg1, arg2) {
        arg0[arg1 >>> 0] = arg2;
    };
    imports.wbg.__wbg_set_bb0c6a7fe60d81b5 = function(arg0, arg1, arg2) {
        arg0.set(getArrayU16FromWasm0(arg1, arg2));
    };
    imports.wbg.__wbindgen_cast_2241b6af4c4b2941 = function(arg0, arg1) {
        // Cast intrinsic for `Ref(String) -> Externref`.
        const ret = getStringFromWasm0(arg0, arg1);
        return ret;
    };
    imports.wbg.__wbindgen_cast_4625c577ab2ec9ee = function(arg0) {
        // Cast intrinsic for `U64 -> Externref`.
        const ret = BigInt.asUintN(64, arg0);
        return ret;
    };
    imports.wbg.__wbindgen_cast_d6cd19b81560fd6e = function(arg0) {
        // Cast intrinsic for `F64 -> Externref`.
        const ret = arg0;
        return ret;
    };
    imports.wbg.__wbindgen_init_externref_table = function() {
        const table = wasm.__wbindgen_externrefs;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
    };

    return imports;
}

function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedDataViewMemory0 = null;
    cachedUint16ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;


    wasm.__wbindgen_start();
    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (typeof module !== 'undefined') {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (typeof module_or_path !== 'undefined') {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (typeof module_or_path === 'undefined') {
        module_or_path = new URL('wasm_mesher_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync };
export default __wbg_init;
