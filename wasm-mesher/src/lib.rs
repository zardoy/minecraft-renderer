use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

mod chunk;
mod chunk_parser_common;
mod dump_parser;
mod geometry;
mod lighting;
mod mesher;
mod parser_v18plus;
mod parser_v16_v17;
mod utils;

use chunk::ChunkData;
use mesher::{GeometryOutput, Mesher};

// Optional: Use wee_alloc for smaller binary size
// #[cfg(feature = "wee_alloc")]
// #[global_allocator]
// static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

// Note: Panic hook would require console_error_panic_hook dependency
// For now, we'll rely on better error messages from expect() calls

/// Main entry point for generating geometry
///
/// Input: Serialized chunk data as TypedArrays
/// Output: Geometry data (positions, normals, colors, uvs, indices)
#[wasm_bindgen]
pub fn generate_geometry(
    section_x: i32,
    section_y: i32,
    section_z: i32,
    section_height: i32,
    world_min_y: i32,
    world_max_y: i32,
    section_data_start_y: i32,
    block_states: &[u16],
    block_light: &[u8],
    sky_light: &[u8],
    biomes: &[u8],
    invisible_blocks: &[u16],
    transparent_blocks: &[u16],
    no_ao_blocks: &[u16],
    cull_identical_blocks: &[u16],
    occluding_blocks: &[u16],
    enable_lighting: bool,
    smooth_lighting: bool,
    sky_light_value: u8,
) -> JsValue {
    let chunk_data_height = (block_states.len() / (16 * 16)) as i32;
    if chunk_data_height < section_height {
        let err_msg = format!(
            "block_states too small: data covers {} Y layers but section_height is {}",
            chunk_data_height,
            section_height
        );
        wasm_bindgen::throw_str(&err_msg);
    }

    let mesher = Mesher::new(
        section_x,
        section_y,
        section_z,
        section_height,
        section_data_start_y,
        world_min_y,
        world_max_y,
        enable_lighting,
        smooth_lighting,
        sky_light_value,
    );

    let result = mesher.generate(
        block_states,
        block_light,
        sky_light,
        biomes,
        invisible_blocks,
        transparent_blocks,
        no_ao_blocks,
        cull_identical_blocks,
        occluding_blocks,
    );

    serde_wasm_bindgen::to_value(&result).expect("Failed to serialize geometry output to JS value")
}

#[wasm_bindgen]
pub fn generate_geometry_multi(
    section_x: i32,
    section_y: i32,
    section_z: i32,
    section_height: i32,
    world_min_y: i32,
    world_max_y: i32,
    section_data_start_y: i32,
    chunk_xs: &[i32],
    chunk_zs: &[i32],
    block_states: &[u16],
    block_light: &[u8],
    sky_light: &[u8],
    biomes: &[u8],
    invisible_blocks: &[u16],
    transparent_blocks: &[u16],
    no_ao_blocks: &[u16],
    cull_identical_blocks: &[u16],
    occluding_blocks: &[u16],
    enable_lighting: bool,
    smooth_lighting: bool,
    sky_light_value: u8,
) -> JsValue {
    let count = chunk_xs.len();
    if count == 0 || chunk_zs.len() != count {
        wasm_bindgen::throw_str("chunk_xs/chunk_zs must be same non-zero length");
    }

    let per_chunk_size = block_states.len() / count;
    let chunk_data_height = (per_chunk_size / (16 * 16)) as i32;
    if chunk_data_height < section_height {
        wasm_bindgen::throw_str("block_states too small: chunk_data_height < section_height");
    }

    let expected_total = per_chunk_size * count;
    if block_states.len() < expected_total {
        wasm_bindgen::throw_str("block_states length too small for chunk count");
    }
    if block_light.len() < expected_total {
        wasm_bindgen::throw_str("block_light length too small for chunk count");
    }
    if sky_light.len() < expected_total {
        wasm_bindgen::throw_str("sky_light length too small for chunk count");
    }
    if biomes.len() < expected_total {
        wasm_bindgen::throw_str("biomes length too small for chunk count");
    }

    let mesher = Mesher::new(
        section_x,
        section_y,
        section_z,
        section_height,
        section_data_start_y,
        world_min_y,
        world_max_y,
        enable_lighting,
        smooth_lighting,
        sky_light_value,
    );

    let mut chunks = Vec::with_capacity(count);
    for i in 0..count {
        let start = i * per_chunk_size;
        let end = start + per_chunk_size;
        chunks.push(ChunkData {
            block_states: &block_states[start..end],
            block_light: &block_light[start..end],
            sky_light: &sky_light[start..end],
            biomes: &biomes[start..end],
            chunk_x: chunk_xs[i],
            chunk_z: chunk_zs[i],
            world_min_y: section_data_start_y,
            world_height: chunk_data_height,
        });
    }

    let result = mesher.generate_multi(
        chunks,
        invisible_blocks,
        transparent_blocks,
        no_ao_blocks,
        cull_identical_blocks,
        occluding_blocks,
    );

    serde_wasm_bindgen::to_value(&result).expect("Failed to serialize geometry output to JS value")
}

/// Parse a 1.18+ Minecraft chunk dump (column.dump() output).
///
/// Returns an object: { blockStates: Uint16Array, biomes: Uint8Array, bytesRead: number }.
/// Throws on parse error.
#[wasm_bindgen(js_name = parseChunkDump118)]
pub fn parse_chunk_dump_1_18(
    buffer: &[u8],
    num_sections: u32,
    max_bits_per_block: u8,
    max_bits_per_biome: u8,
) -> JsValue {
    match dump_parser::parse_dump(buffer, num_sections as usize, max_bits_per_block, max_bits_per_biome) {
        Ok(r) => {
            let obj = js_sys::Object::new();
            let blocks_view = js_sys::Uint16Array::new_with_length(r.block_states.len() as u32);
            blocks_view.copy_from(&r.block_states);
            let biomes_view = js_sys::Uint8Array::new_with_length(r.biomes.len() as u32);
            biomes_view.copy_from(&r.biomes);
            js_sys::Reflect::set(&obj, &JsValue::from_str("blockStates"), &blocks_view).unwrap();
            js_sys::Reflect::set(&obj, &JsValue::from_str("biomes"), &biomes_view).unwrap();
            js_sys::Reflect::set(&obj, &JsValue::from_str("bytesRead"), &JsValue::from_f64(r.bytes_read as f64)).unwrap();
            obj.into()
        }
        Err(e) => wasm_bindgen::throw_str(&format!("parseChunkDump118 error: {}", e)),
    }
}

/// Unpack a single light section (2048 bytes, BitArrayNoSpan bpv=4) into 4096 nibble values.
#[wasm_bindgen(js_name = unpackLightSection118)]
pub fn unpack_light_section_1_18(buffer: &[u8]) -> Vec<u8> {
    match dump_parser::unpack_light_section(buffer) {
        Ok(v) => v,
        Err(e) => wasm_bindgen::throw_str(&format!("unpackLightSection118 error: {}", e)),
    }
}

/// PoC bench helper: parse dump but return ONLY a checksum (no Uint16Array marshalling).
/// Lets us isolate raw parse cost from the JS<->WASM boundary cost.
#[wasm_bindgen(js_name = parseChunkDump118NoMarshal)]
pub fn parse_chunk_dump_1_18_no_marshal(
    buffer: &[u8],
    num_sections: u32,
    max_bits_per_block: u8,
    max_bits_per_biome: u8,
) -> f64 {
    match dump_parser::parse_dump_checksum(buffer, num_sections as usize, max_bits_per_block, max_bits_per_biome) {
        Ok(v) => v as f64,
        Err(e) => wasm_bindgen::throw_str(&format!("parseChunkDump118NoMarshal error: {}", e)),
    }
}

/// Full drop-in replacement for `convertChunkToWasm`: parses dump + assembles light into
/// `convertChunkToWasm`-shaped Uint16Array(blocks) + Uint8Array(biomes/blockLight/skyLight).
///
/// Light masks come as Uint32Array laid out as (low0, high0, low1, high1, ...).
/// The JS side flattens prismarine's [[high, low]] format into that order:
///   `Uint32Array.of(...mask.flatMap(([h, l]) => [l >>> 0, h >>> 0]))`.
///
/// `sky_light_concat` / `block_light_concat` = concatenation of present light section
/// buffers (each 2048 bytes), in mask-bit order (border-below first).
///
/// Returns: { blockStates: Uint16Array, biomes: Uint8Array, blockLight: Uint8Array,
///            skyLight: Uint8Array, bytesRead: number }.
#[wasm_bindgen(js_name = parseChunkDump118FullColumnAll)]
pub fn parse_chunk_dump_1_18_full_column_all(
    dump_buffer: &[u8],
    sky_light_concat: &[u8],
    block_light_concat: &[u8],
    sky_light_mask: &[u32],
    block_light_mask: &[u32],
    empty_sky_light_mask: &[u32],
    empty_block_light_mask: &[u32],
    num_sections: u32,
    max_bits_per_block: u8,
    max_bits_per_biome: u8,
) -> JsValue {
    let blocks_biomes = match dump_parser::parse_dump_full_column(
        dump_buffer, num_sections as usize, max_bits_per_block, max_bits_per_biome,
    ) {
        Ok(r) => r,
        Err(e) => wasm_bindgen::throw_str(&format!("parseChunkDump118FullColumnAll: parse error: {}", e)),
    };
    let sky = match dump_parser::assemble_light_full_column(
        sky_light_concat, sky_light_mask, empty_sky_light_mask, num_sections as usize, 0, true,
    ) {
        Ok(v) => v,
        Err(e) => wasm_bindgen::throw_str(&format!("parseChunkDump118FullColumnAll: skyLight error: {}", e)),
    };
    let block = match dump_parser::assemble_light_full_column(
        block_light_concat, block_light_mask, empty_block_light_mask, num_sections as usize, 0, true,
    ) {
        Ok(v) => v,
        Err(e) => wasm_bindgen::throw_str(&format!("parseChunkDump118FullColumnAll: blockLight error: {}", e)),
    };

    let obj = js_sys::Object::new();
    let blocks_view = js_sys::Uint16Array::new_with_length(blocks_biomes.block_states.len() as u32);
    blocks_view.copy_from(&blocks_biomes.block_states);
    let biomes_view = js_sys::Uint8Array::new_with_length(blocks_biomes.biomes.len() as u32);
    biomes_view.copy_from(&blocks_biomes.biomes);
    let block_light_view = js_sys::Uint8Array::new_with_length(block.len() as u32);
    block_light_view.copy_from(&block);
    let sky_light_view = js_sys::Uint8Array::new_with_length(sky.len() as u32);
    sky_light_view.copy_from(&sky);
    js_sys::Reflect::set(&obj, &JsValue::from_str("blockStates"), &blocks_view).unwrap();
    js_sys::Reflect::set(&obj, &JsValue::from_str("biomes"), &biomes_view).unwrap();
    js_sys::Reflect::set(&obj, &JsValue::from_str("blockLight"), &block_light_view).unwrap();
    js_sys::Reflect::set(&obj, &JsValue::from_str("skyLight"), &sky_light_view).unwrap();
    js_sys::Reflect::set(&obj, &JsValue::from_str("bytesRead"), &JsValue::from_f64(blocks_biomes.bytes_read as f64)).unwrap();
    obj.into()
}

/// VITALY's path: parse 1.18+ dump + light → run the mesher → return ONLY the final
/// geometry. Avoids marshalling the intermediate ~300KB block_states/biomes/lights
/// arrays back to JS.
///
/// Combines `parseChunkDump118FullColumnAll` and `generate_geometry` into one Rust call.
/// All `generate_geometry` parameters (mesher config, block-state lists) are accepted
/// unchanged.
#[wasm_bindgen(js_name = generateGeometryFromDump118)]
pub fn generate_geometry_from_dump_1_18(
    section_x: i32,
    section_y: i32,
    section_z: i32,
    section_height: i32,
    world_min_y: i32,
    world_max_y: i32,
    section_data_start_y: i32,
    // dump inputs
    dump_buffer: &[u8],
    sky_light_concat: &[u8],
    block_light_concat: &[u8],
    sky_light_mask: &[u32],
    block_light_mask: &[u32],
    empty_sky_light_mask: &[u32],
    empty_block_light_mask: &[u32],
    num_sections: u32,
    max_bits_per_block: u8,
    max_bits_per_biome: u8,
    // mesher config (same as generate_geometry)
    invisible_blocks: &[u16],
    transparent_blocks: &[u16],
    no_ao_blocks: &[u16],
    cull_identical_blocks: &[u16],
    occluding_blocks: &[u16],
    enable_lighting: bool,
    smooth_lighting: bool,
    sky_light_value: u8,
) -> JsValue {
    let blocks_biomes = match dump_parser::parse_dump_full_column(
        dump_buffer, num_sections as usize, max_bits_per_block, max_bits_per_biome,
    ) {
        Ok(r) => r,
        Err(e) => wasm_bindgen::throw_str(&format!("generateGeometryFromDump118: parse error: {}", e)),
    };
    let sky = match dump_parser::assemble_light_full_column(
        sky_light_concat, sky_light_mask, empty_sky_light_mask, num_sections as usize, 0, true,
    ) {
        Ok(v) => v,
        Err(e) => wasm_bindgen::throw_str(&format!("generateGeometryFromDump118: skyLight error: {}", e)),
    };
    let block_light = match dump_parser::assemble_light_full_column(
        block_light_concat, block_light_mask, empty_block_light_mask, num_sections as usize, 0, true,
    ) {
        Ok(v) => v,
        Err(e) => wasm_bindgen::throw_str(&format!("generateGeometryFromDump118: blockLight error: {}", e)),
    };

    let mesher = Mesher::new(
        section_x,
        section_y,
        section_z,
        section_height,
        section_data_start_y,
        world_min_y,
        world_max_y,
        enable_lighting,
        smooth_lighting,
        sky_light_value,
    );

    let result = mesher.generate(
        &blocks_biomes.block_states,
        &block_light,
        &sky,
        &blocks_biomes.biomes,
        invisible_blocks,
        transparent_blocks,
        no_ao_blocks,
        cull_identical_blocks,
        occluding_blocks,
    );

    serde_wasm_bindgen::to_value(&result).expect("Failed to serialize geometry output to JS value")
}
///   index = x + z*16 + y*256, where y goes 0..(num_sections*16).
/// Biomes are expanded from per-section 4×4×4 to per-block (matching prismarine-chunk's
/// `getBiome(pos)`).
///
/// This is the drop-in replacement for `convertChunkToWasm`'s blocks+biomes extraction:
/// no JS hot loop, no per-section-to-full-column reorder. Light is still produced by
/// `unpackLightSection118` per section (caller is responsible).
///
/// Returns: { blockStates: Uint16Array, biomes: Uint8Array, bytesRead: number }.
#[wasm_bindgen(js_name = parseChunkDump118FullColumn)]
pub fn parse_chunk_dump_1_18_full_column(
    buffer: &[u8],
    num_sections: u32,
    max_bits_per_block: u8,
    max_bits_per_biome: u8,
) -> JsValue {
    match dump_parser::parse_dump_full_column(buffer, num_sections as usize, max_bits_per_block, max_bits_per_biome) {
        Ok(r) => {
            let obj = js_sys::Object::new();
            let blocks_view = js_sys::Uint16Array::new_with_length(r.block_states.len() as u32);
            blocks_view.copy_from(&r.block_states);
            let biomes_view = js_sys::Uint8Array::new_with_length(r.biomes.len() as u32);
            biomes_view.copy_from(&r.biomes);
            js_sys::Reflect::set(&obj, &JsValue::from_str("blockStates"), &blocks_view).unwrap();
            js_sys::Reflect::set(&obj, &JsValue::from_str("biomes"), &biomes_view).unwrap();
            js_sys::Reflect::set(&obj, &JsValue::from_str("bytesRead"), &JsValue::from_f64(r.bytes_read as f64)).unwrap();
            obj.into()
        }
        Err(e) => wasm_bindgen::throw_str(&format!("parseChunkDump118FullColumn error: {}", e)),
    }
}

/// Fused parse+mesh for 1.18+ `map_chunk` wire format.
///
/// Parses the raw packet inside Rust, meshes immediately, and returns ONLY the
/// final `GeometryOutput` — no intermediate typed arrays are materialised on the
/// JS heap.  This halves the number of JS<->WASM boundary crossings per column
/// and removes the largest per-column allocations (Uint16Array block_states +
/// three Uint8Arrays for biomes/light).
///
/// `raw_packet` is the buffer captured from `bot._client.on('raw.map_chunk', ...)`;
/// it includes the leading packet-id varint (we skip it).
#[wasm_bindgen(js_name = generateGeometryFromMapChunkV18Plus)]
pub fn generate_geometry_from_map_chunk_v18plus(
    raw_packet: &[u8],
    num_sections: u32,
    max_bits_per_block: u8,
    max_bits_per_biome: u8,
    protocol: i32,
    section_x: i32,
    section_y: i32,
    section_z: i32,
    section_height: i32,
    world_min_y: i32,
    world_max_y: i32,
    section_data_start_y: i32,
    invisible_blocks: &[u16],
    transparent_blocks: &[u16],
    no_ao_blocks: &[u16],
    cull_identical_blocks: &[u16],
    occluding_blocks: &[u16],
    enable_lighting: bool,
    smooth_lighting: bool,
    sky_light_value: u8,
) -> JsValue {
    match generate_geometry_from_map_chunk_v18plus_inner(
        raw_packet, num_sections, max_bits_per_block, max_bits_per_biome, protocol,
        section_x, section_y, section_z, section_height, world_min_y, world_max_y, section_data_start_y,
        invisible_blocks, transparent_blocks, no_ao_blocks, cull_identical_blocks, occluding_blocks,
        enable_lighting, smooth_lighting, sky_light_value,
    ) {
        Ok(result) => serde_wasm_bindgen::to_value(&result).expect("serialize"),
        Err(e) => wasm_bindgen::throw_str(&e),
    }
}

fn generate_geometry_from_map_chunk_v18plus_inner(
    raw_packet: &[u8],
    num_sections: u32,
    max_bits_per_block: u8,
    max_bits_per_biome: u8,
    protocol: i32,
    section_x: i32,
    section_y: i32,
    section_z: i32,
    section_height: i32,
    world_min_y: i32,
    world_max_y: i32,
    section_data_start_y: i32,
    invisible_blocks: &[u16],
    transparent_blocks: &[u16],
    no_ao_blocks: &[u16],
    cull_identical_blocks: &[u16],
    occluding_blocks: &[u16],
    enable_lighting: bool,
    smooth_lighting: bool,
    sky_light_value: u8,
) -> Result<GeometryOutput, String> {
    let flags = parser_v18plus::McVersionFlags::for_protocol(protocol);
    let parsed = parser_v18plus::parse_map_chunk_v18plus(
        raw_packet, num_sections as usize, max_bits_per_block, max_bits_per_biome, flags,
    ).map_err(|e| format!("generateGeometryFromMapChunkV18Plus: parse error: {}", e))?;

    let mesher = Mesher::new(
        section_x, section_y, section_z,
        section_height, section_data_start_y,
        world_min_y, world_max_y,
        enable_lighting, smooth_lighting, sky_light_value,
    );

    let result = mesher.generate(
        &parsed.block_states,
        &parsed.block_light,
        &parsed.sky_light,
        &parsed.biomes,
        invisible_blocks,
        transparent_blocks,
        no_ao_blocks,
        cull_identical_blocks,
        occluding_blocks,
    );

    Ok(result)
}

/// Stage-3 entry: parse a raw `map_chunk` packet (1.18+) into the same shape as
/// `parseChunkDump118FullColumnAll` so the worker can drop it straight into
/// `generate_geometry`.
///
/// `raw_packet` is the buffer captured from `bot._client.on('raw.map_chunk', ...)`;
/// it includes the leading packet-id varint (we skip it). `protocol` selects
/// the version-specific quirks (heightmaps NBT, trust_edges, anonymous NBT, etc.).
///
/// Returns: `{ x, z, blockStates: Uint16Array, biomes: Uint8Array,
///             blockLight: Uint8Array, skyLight: Uint8Array, bytesRead }`.
#[wasm_bindgen(js_name = parseMapChunkV18Plus)]
pub fn parse_map_chunk_v18plus_js(
    raw_packet: &[u8],
    num_sections: u32,
    max_bits_per_block: u8,
    max_bits_per_biome: u8,
    protocol: i32,
) -> JsValue {
    let flags = parser_v18plus::McVersionFlags::for_protocol(protocol);
    let result = match parser_v18plus::parse_map_chunk_v18plus(
        raw_packet, num_sections as usize, max_bits_per_block, max_bits_per_biome, flags,
    ) {
        Ok(r) => r,
        Err(e) => wasm_bindgen::throw_str(&format!("parseMapChunkV18Plus error: {}", e)),
    };

    let obj = js_sys::Object::new();
    let blocks_view = js_sys::Uint16Array::new_with_length(result.block_states.len() as u32);
    blocks_view.copy_from(&result.block_states);
    let biomes_view = js_sys::Uint8Array::new_with_length(result.biomes.len() as u32);
    biomes_view.copy_from(&result.biomes);
    let block_light_view = js_sys::Uint8Array::new_with_length(result.block_light.len() as u32);
    block_light_view.copy_from(&result.block_light);
    let sky_light_view = js_sys::Uint8Array::new_with_length(result.sky_light.len() as u32);
    sky_light_view.copy_from(&result.sky_light);
    js_sys::Reflect::set(&obj, &JsValue::from_str("x"), &JsValue::from_f64(result.x as f64)).unwrap();
    js_sys::Reflect::set(&obj, &JsValue::from_str("z"), &JsValue::from_f64(result.z as f64)).unwrap();
    js_sys::Reflect::set(&obj, &JsValue::from_str("blockStates"), &blocks_view).unwrap();
    js_sys::Reflect::set(&obj, &JsValue::from_str("biomes"), &biomes_view).unwrap();
    js_sys::Reflect::set(&obj, &JsValue::from_str("blockLight"), &block_light_view).unwrap();
    js_sys::Reflect::set(&obj, &JsValue::from_str("skyLight"), &sky_light_view).unwrap();
    js_sys::Reflect::set(&obj, &JsValue::from_str("bytesRead"), &JsValue::from_f64(result.bytes_read as f64)).unwrap();
    obj.into()
}

/// Parse a 1.17 chunk-section payload (the bytes inside `chunkData` of a
/// `map_chunk` packet) into a flat `Uint16Array` of block states **and** an
/// expanded per-block biome `Uint8Array`.
///
/// `chunk_data` — exactly the bytes between the `chunkData` length prefix and
/// the `blockEntities` count in the wire packet (i.e. what
/// `prismarine-chunk` 1.17 `ChunkColumn.load(data, bitMap)` consumes). The
/// JS-side caller (mineflayer/protodef) does the outer-packet parsing and
/// hands the slice in directly.
///
/// `bit_map_lo_hi` — section mask flattened to `[low0, high0, low1, high1,
/// ...]` u32 pairs. Bit `s` indicates that section index `s` is present in
/// `chunk_data`. Sections without a set bit decode to all-zeros.
///
/// `biomes_cells` — the 1.17 wire `biomes` field (varint[num_sections * 64]),
/// passed straight through as `Int32Array`. May be empty (`&[]`) when the
/// caller didn't capture biomes — every block then gets `default_biome`
/// (typically 1 = plains).
///
/// Returns `{ blockStates: Uint16Array(num_sections * 4096),
///            biomes: Uint8Array(num_sections * 4096),
///            bytesRead, bytesTotal }`.
/// Layout of both arrays is `(s * 4096) | (y_in << 8) | (z << 4) | x`,
/// matching what the WASM mesher already consumes for 1.18+ blocks.
///
/// Light is **not** produced here — in 1.17 it arrives in a separate
/// `update_light` packet (see `parseUpdateLightV17`). The JS bridge fills in
/// defaults (sky=15, block=0) or merges real data from a paired light cache.
#[wasm_bindgen(js_name = parseChunkSectionsV16V17)]
pub fn parse_chunk_sections_v16_v17_js(
    chunk_data: &[u8],
    bit_map_lo_hi: &[u32],
    num_sections: u32,
    max_bits_per_block: u8,
    biomes_cells: &[i32],
    default_biome: u8,
) -> JsValue {
    let cells_opt: Option<&[i32]> = if biomes_cells.is_empty() { None } else { Some(biomes_cells) };
    let result = match parser_v16_v17::parse_chunk_sections_v16_v17(
        chunk_data,
        bit_map_lo_hi,
        num_sections as usize,
        max_bits_per_block,
        cells_opt,
        default_biome,
    ) {
        Ok(r) => r,
        Err(e) => wasm_bindgen::throw_str(&format!("parseChunkSectionsV16V17 error: {}", e)),
    };

    let obj = js_sys::Object::new();
    let blocks_view = js_sys::Uint16Array::new_with_length(result.block_states.len() as u32);
    blocks_view.copy_from(&result.block_states);
    let biomes_view = js_sys::Uint8Array::new_with_length(result.biomes.len() as u32);
    biomes_view.copy_from(&result.biomes);
    js_sys::Reflect::set(&obj, &JsValue::from_str("blockStates"), &blocks_view).unwrap();
    js_sys::Reflect::set(&obj, &JsValue::from_str("biomes"), &biomes_view).unwrap();
    js_sys::Reflect::set(&obj, &JsValue::from_str("bytesRead"),
        &JsValue::from_f64(result.bytes_read as f64)).unwrap();
    js_sys::Reflect::set(&obj, &JsValue::from_str("bytesTotal"),
        &JsValue::from_f64(result.bytes_total as f64)).unwrap();
    obj.into()
}

/// Fused parse+mesh for 1.16 / 1.17 chunk sections.
///
/// Parses `chunk_data` (the raw section bytes from a `map_chunk` packet) inside
/// Rust and meshes immediately, returning only `GeometryOutput`.  Block states
/// and biomes never leave WASM memory.
///
/// Light arrays (`sky_light` / `block_light`) come from a pre-parsed
/// `update_light` packet and are passed by reference (the JS-side update-light
/// cache already holds them as `Uint8Array`).  When light is absent the
/// function fills defaults (sky=15, block=0) internally.
#[wasm_bindgen(js_name = generateGeometryFromParsedV16V17)]
pub fn generate_geometry_from_parsed_v16_v17(
    chunk_data: &[u8],
    bit_map_lo_hi: &[u32],
    num_sections: u32,
    max_bits_per_block: u8,
    biomes_cells: &[i32],
    default_biome: u8,
    sky_light: &[u8],
    block_light: &[u8],
    section_x: i32,
    section_y: i32,
    section_z: i32,
    section_height: i32,
    world_min_y: i32,
    world_max_y: i32,
    section_data_start_y: i32,
    invisible_blocks: &[u16],
    transparent_blocks: &[u16],
    no_ao_blocks: &[u16],
    cull_identical_blocks: &[u16],
    occluding_blocks: &[u16],
    enable_lighting: bool,
    smooth_lighting: bool,
    sky_light_value: u8,
) -> JsValue {
    match generate_geometry_from_parsed_v16_v17_inner(
        chunk_data, bit_map_lo_hi, num_sections, max_bits_per_block,
        biomes_cells, default_biome, sky_light, block_light,
        section_x, section_y, section_z, section_height,
        world_min_y, world_max_y, section_data_start_y,
        invisible_blocks, transparent_blocks, no_ao_blocks,
        cull_identical_blocks, occluding_blocks,
        enable_lighting, smooth_lighting, sky_light_value,
    ) {
        Ok(result) => serde_wasm_bindgen::to_value(&result).expect("serialize"),
        Err(e) => wasm_bindgen::throw_str(&e),
    }
}

fn generate_geometry_from_parsed_v16_v17_inner(
    chunk_data: &[u8],
    bit_map_lo_hi: &[u32],
    num_sections: u32,
    max_bits_per_block: u8,
    biomes_cells: &[i32],
    default_biome: u8,
    sky_light: &[u8],
    block_light: &[u8],
    section_x: i32,
    section_y: i32,
    section_z: i32,
    section_height: i32,
    world_min_y: i32,
    world_max_y: i32,
    section_data_start_y: i32,
    invisible_blocks: &[u16],
    transparent_blocks: &[u16],
    no_ao_blocks: &[u16],
    cull_identical_blocks: &[u16],
    occluding_blocks: &[u16],
    enable_lighting: bool,
    smooth_lighting: bool,
    sky_light_value: u8,
) -> Result<GeometryOutput, String> {
    let cells_opt: Option<&[i32]> = if biomes_cells.is_empty() { None } else { Some(biomes_cells) };
    let parsed = parser_v16_v17::parse_chunk_sections_v16_v17(
        chunk_data,
        bit_map_lo_hi,
        num_sections as usize,
        max_bits_per_block,
        cells_opt,
        default_biome,
    ).map_err(|e| format!("generateGeometryFromParsedV16V17: parse error: {}", e))?;

    let total_blocks = parsed.block_states.len();
    let sky_fill: Vec<u8>;
    let block_fill: Vec<u8>;
    let sky_ref: &[u8] = if sky_light.len() == total_blocks {
        sky_light
    } else {
        sky_fill = vec![15u8; total_blocks];
        &sky_fill
    };
    let block_ref: &[u8] = if block_light.len() == total_blocks {
        block_light
    } else {
        block_fill = vec![0u8; total_blocks];
        &block_fill
    };

    let mesher = Mesher::new(
        section_x, section_y, section_z,
        section_height, section_data_start_y,
        world_min_y, world_max_y,
        enable_lighting, smooth_lighting, sky_light_value,
    );

    let result = mesher.generate(
        &parsed.block_states,
        block_ref,
        sky_ref,
        &parsed.biomes,
        invisible_blocks,
        transparent_blocks,
        no_ao_blocks,
        cull_identical_blocks,
        occluding_blocks,
    );

    Ok(result)
}

/// Fused multi-column parse+mesh for 1.18+ raw map_chunk.
///
/// Parses multiple raw packets inside Rust and meshes them in a single
/// `mesher.generate_multi` call with correct per-neighbor AO/lighting.
/// No typed arrays are materialised on the JS heap.
///
/// `raw_packets` — `Array<Uint8Array>`, one raw packet per column.
/// Reuses the existing JS-side per-column buffers (zero concat, zero alloc).
///
/// `num_sections_list` — per-column section count (terrain height varies).
///
/// Invariant: `chunk_xs[0]` / `chunk_zs[0]` is the **target** column whose
/// geometry is emitted. Neighbour columns provide border data to the mesher
/// but do not contribute directly to the output.
#[wasm_bindgen(js_name = generateGeometryFromMapChunkV18PlusMulti)]
#[allow(non_snake_case)]
pub fn generate_geometry_from_map_chunk_v18plus_multi(
    raw_packets: js_sys::Array,
    num_sections_list: &[u32],
    max_bits_per_block: u8,
    max_bits_per_biome: u8,
    protocol: i32,
    chunk_xs: &[i32],
    chunk_zs: &[i32],
    // --- mesh config (same as generate_geometry_multi) ---
    section_x: i32,
    section_y: i32,
    section_z: i32,
    section_height: i32,
    world_min_y: i32,
    world_max_y: i32,
    section_data_start_y: i32,
    invisible_blocks: &[u16],
    transparent_blocks: &[u16],
    no_ao_blocks: &[u16],
    cull_identical_blocks: &[u16],
    occluding_blocks: &[u16],
    enable_lighting: bool,
    smooth_lighting: bool,
    sky_light_value: u8,
) -> JsValue {
    let count = chunk_xs.len();
    let mut raw_bufs: Vec<Vec<u8>> = Vec::with_capacity(count);
    for i in 0..count {
        let raw: js_sys::Uint8Array = raw_packets
            .get(i as u32)
            .dyn_into()
            .unwrap_or_else(|_| wasm_bindgen::throw_str("generateGeometryFromMapChunkV18PlusMulti: element is not Uint8Array"));
        raw_bufs.push(raw.to_vec());
    }

    match generate_geometry_from_map_chunk_v18plus_multi_inner(
        &raw_bufs, num_sections_list, max_bits_per_block, max_bits_per_biome, protocol,
        chunk_xs, chunk_zs,
        section_x, section_y, section_z, section_height,
        world_min_y, world_max_y, section_data_start_y,
        invisible_blocks, transparent_blocks, no_ao_blocks,
        cull_identical_blocks, occluding_blocks,
        enable_lighting, smooth_lighting, sky_light_value,
    ) {
        Ok(result) => serde_wasm_bindgen::to_value(&result).expect("serialize"),
        Err(e) => wasm_bindgen::throw_str(&e),
    }
}

fn generate_geometry_from_map_chunk_v18plus_multi_inner(
    raw_packets: &[Vec<u8>],
    num_sections_list: &[u32],
    max_bits_per_block: u8,
    max_bits_per_biome: u8,
    protocol: i32,
    chunk_xs: &[i32],
    chunk_zs: &[i32],
    section_x: i32,
    section_y: i32,
    section_z: i32,
    section_height: i32,
    world_min_y: i32,
    world_max_y: i32,
    section_data_start_y: i32,
    invisible_blocks: &[u16],
    transparent_blocks: &[u16],
    no_ao_blocks: &[u16],
    cull_identical_blocks: &[u16],
    occluding_blocks: &[u16],
    enable_lighting: bool,
    smooth_lighting: bool,
    sky_light_value: u8,
) -> Result<GeometryOutput, String> {
    let flags = parser_v18plus::McVersionFlags::for_protocol(protocol);
    let count = chunk_xs.len();

    let mut parsed_all: Vec<parser_v18plus::MapChunkResult> = Vec::with_capacity(count);
    for i in 0..count {
        let parsed = parser_v18plus::parse_map_chunk_v18plus(
            &raw_packets[i],
            num_sections_list[i] as usize,
            max_bits_per_block,
            max_bits_per_biome,
            flags,
        ).map_err(|e| format!("generateGeometryFromMapChunkV18PlusMulti: parse error at index {}: {}", i, e))?;
        parsed_all.push(parsed);
    }

    let chunks: Vec<ChunkData> = parsed_all
        .iter()
        .zip(chunk_xs.iter().zip(chunk_zs.iter()).zip(num_sections_list.iter()))
        .map(|(p, ((&cx, &cz), &ns))| {
            let world_height = (ns as usize * 4096 / 256) as i32;
            ChunkData {
                block_states: &p.block_states,
                block_light: &p.block_light,
                sky_light: &p.sky_light,
                biomes: &p.biomes,
                chunk_x: cx,
                chunk_z: cz,
                world_min_y: section_data_start_y,
                world_height,
            }
        })
        .collect();

    let mesher = Mesher::new(
        section_x, section_y, section_z,
        section_height, section_data_start_y,
        world_min_y, world_max_y,
        enable_lighting, smooth_lighting, sky_light_value,
    );

    Ok(mesher.generate_multi(
        chunks,
        invisible_blocks,
        transparent_blocks,
        no_ao_blocks,
        cull_identical_blocks,
        occluding_blocks,
    ))
}

/// Fused multi-column parse+mesh for 1.16 / 1.17 chunk sections.
///
/// Parses multiple columns inside Rust and meshes them in one
/// `mesher.generate_multi` call.  Block states and biomes never leave WASM
/// memory; light arrays are passed by reference from the JS-side
/// update-light caches.
///
/// `chunk_data_list` — `Array<Uint8Array>`, one chunk_data buffer per column.
/// `bit_map_lo_hi` — flat `&[u32]` of length `chunkCount * 2`; each pair
///                    (lo, hi) is the section mask for one column.
/// `num_sections_list` — per-column section count.
/// `biomes_cells_list` — `Array<Int32Array>`, may contain empty arrays for
///                        columns without captured biomes.
/// `sky_light_list` / `block_light_list` — `Array<Uint8Array>`, may contain
///   empty arrays for columns where update_light has not arrived yet.
///
/// Invariant: `chunk_xs[0]` / `chunk_zs[0]` is the target column.
#[wasm_bindgen(js_name = generateGeometryFromParsedV16V17Multi)]
#[allow(non_snake_case)]
pub fn generate_geometry_from_parsed_v16_v17_multi(
    chunk_data_list: js_sys::Array,
    bit_map_lo_hi: &[u32],
    num_sections_list: &[u32],
    max_bits_per_block: u8,
    biomes_cells_list: js_sys::Array,
    default_biome: u8,
    sky_light_list: js_sys::Array,
    block_light_list: js_sys::Array,
    chunk_xs: &[i32],
    chunk_zs: &[i32],
    // --- mesh config ---
    section_x: i32,
    section_y: i32,
    section_z: i32,
    section_height: i32,
    world_min_y: i32,
    world_max_y: i32,
    section_data_start_y: i32,
    invisible_blocks: &[u16],
    transparent_blocks: &[u16],
    no_ao_blocks: &[u16],
    cull_identical_blocks: &[u16],
    occluding_blocks: &[u16],
    enable_lighting: bool,
    smooth_lighting: bool,
    sky_light_value: u8,
) -> JsValue {
    let count = chunk_xs.len();
    let mut chunk_data_bufs: Vec<Vec<u8>> = Vec::with_capacity(count);
    let mut biomes_bufs: Vec<Vec<i32>> = Vec::with_capacity(count);
    let mut sky_bufs: Vec<Vec<u8>> = Vec::with_capacity(count);
    let mut block_bufs: Vec<Vec<u8>> = Vec::with_capacity(count);
    for i in 0..count {
        let chunk_data: js_sys::Uint8Array = chunk_data_list
            .get(i as u32)
            .dyn_into()
            .unwrap_or_else(|_| wasm_bindgen::throw_str("generateGeometryFromParsedV16V17Multi: chunk_data element is not Uint8Array"));
        chunk_data_bufs.push(chunk_data.to_vec());

        let biomes: js_sys::Int32Array = biomes_cells_list.get(i as u32).dyn_into().unwrap_or_else(|_| {
            js_sys::Int32Array::new_with_length(0)
        });
        biomes_bufs.push(biomes.to_vec());

        let sky_arr: js_sys::Uint8Array = sky_light_list.get(i as u32).dyn_into().unwrap_or_else(|_| {
            js_sys::Uint8Array::new_with_length(0)
        });
        sky_bufs.push(sky_arr.to_vec());

        let block_arr: js_sys::Uint8Array = block_light_list.get(i as u32).dyn_into().unwrap_or_else(|_| {
            js_sys::Uint8Array::new_with_length(0)
        });
        block_bufs.push(block_arr.to_vec());
    }

    match generate_geometry_from_parsed_v16_v17_multi_inner(
        &chunk_data_bufs, bit_map_lo_hi, num_sections_list, max_bits_per_block,
        &biomes_bufs, default_biome,
        &sky_bufs, &block_bufs,
        chunk_xs, chunk_zs,
        section_x, section_y, section_z, section_height,
        world_min_y, world_max_y, section_data_start_y,
        invisible_blocks, transparent_blocks, no_ao_blocks,
        cull_identical_blocks, occluding_blocks,
        enable_lighting, smooth_lighting, sky_light_value,
    ) {
        Ok(result) => serde_wasm_bindgen::to_value(&result).expect("serialize"),
        Err(e) => wasm_bindgen::throw_str(&e),
    }
}

fn generate_geometry_from_parsed_v16_v17_multi_inner(
    chunk_data_list: &[Vec<u8>],
    bit_map_lo_hi: &[u32],
    num_sections_list: &[u32],
    max_bits_per_block: u8,
    biomes_cells_list: &[Vec<i32>],
    default_biome: u8,
    sky_light_list: &[Vec<u8>],
    block_light_list: &[Vec<u8>],
    chunk_xs: &[i32],
    chunk_zs: &[i32],
    section_x: i32,
    section_y: i32,
    section_z: i32,
    section_height: i32,
    world_min_y: i32,
    world_max_y: i32,
    section_data_start_y: i32,
    invisible_blocks: &[u16],
    transparent_blocks: &[u16],
    no_ao_blocks: &[u16],
    cull_identical_blocks: &[u16],
    occluding_blocks: &[u16],
    enable_lighting: bool,
    smooth_lighting: bool,
    sky_light_value: u8,
) -> Result<GeometryOutput, String> {
    let count = chunk_xs.len();

    let mut parsed_all: Vec<parser_v16_v17::ChunkSectionsResult> = Vec::with_capacity(count);
    let mut light_data: Vec<(Vec<u8>, Vec<u8>)> = Vec::with_capacity(count);

    for i in 0..count {
        let cells_opt: Option<&[i32]> = if biomes_cells_list[i].is_empty() { None } else { Some(&biomes_cells_list[i]) };

        let parsed = parser_v16_v17::parse_chunk_sections_v16_v17(
            &chunk_data_list[i],
            &bit_map_lo_hi[i * 2..i * 2 + 2],
            num_sections_list[i] as usize,
            max_bits_per_block,
            cells_opt,
            default_biome,
        ).map_err(|e| format!("generateGeometryFromParsedV16V17Multi: parse error at index {}: {}", i, e))?;
        let total_blocks = parsed.block_states.len();

        let sky_in = &sky_light_list[i];
        let sky = if sky_in.len() == total_blocks { sky_in.clone() } else { vec![15u8; total_blocks] };
        let block_in = &block_light_list[i];
        let block = if block_in.len() == total_blocks { block_in.clone() } else { vec![0u8; total_blocks] };

        parsed_all.push(parsed);
        light_data.push((sky, block));
    }

    let chunks: Vec<ChunkData> = (0..count)
        .map(|i| {
            let p = &parsed_all[i];
            let (ref sky, ref block) = light_data[i];
            let ns = num_sections_list[i];
            let world_height = (ns as usize * 4096 / 256) as i32;
            ChunkData {
                block_states: &p.block_states,
                block_light: block,
                sky_light: sky,
                biomes: &p.biomes,
                chunk_x: chunk_xs[i],
                chunk_z: chunk_zs[i],
                world_min_y: section_data_start_y,
                world_height,
            }
        })
        .collect();

    let mesher = Mesher::new(
        section_x, section_y, section_z,
        section_height, section_data_start_y,
        world_min_y, world_max_y,
        enable_lighting, smooth_lighting, sky_light_value,
    );

    Ok(mesher.generate_multi(
        chunks,
        invisible_blocks,
        transparent_blocks,
        no_ao_blocks,
        cull_identical_blocks,
        occluding_blocks,
    ))
}

/// Parse a raw 1.17 `update_light` packet (as captured by
/// `client.on('raw.update_light', ...)`) into flat per-block sky/block light
/// arrays the WASM mesher consumes.
///
/// `raw_packet` includes the leading packet-id varint (we skip it).
/// `num_sections` should match the column the light is for (16 in 1.17).
///
/// Returns `{ x, z, skyLight: Uint8Array(num_sections * 4096),
///            blockLight: Uint8Array(num_sections * 4096), bytesRead }`.
/// Layout matches the existing 1.18+ light arrays
/// (`x + z*16 + y_abs*256`); the JS-side worker reorders into per-section
/// stack via the same path used for 1.18+ raw map_chunk parsing.
#[wasm_bindgen(js_name = parseUpdateLightV17)]
pub fn parse_update_light_v17_js(
    raw_packet: &[u8],
    num_sections: u32,
) -> JsValue {
    let result = match parser_v16_v17::parse_update_light_v17(raw_packet, num_sections as usize) {
        Ok(r) => r,
        Err(e) => wasm_bindgen::throw_str(&format!("parseUpdateLightV17 error: {}", e)),
    };

    let obj = js_sys::Object::new();
    let sky_view = js_sys::Uint8Array::new_with_length(result.sky_light.len() as u32);
    sky_view.copy_from(&result.sky_light);
    let block_view = js_sys::Uint8Array::new_with_length(result.block_light.len() as u32);
    block_view.copy_from(&result.block_light);
    js_sys::Reflect::set(&obj, &JsValue::from_str("x"), &JsValue::from_f64(result.x as f64)).unwrap();
    js_sys::Reflect::set(&obj, &JsValue::from_str("z"), &JsValue::from_f64(result.z as f64)).unwrap();
    js_sys::Reflect::set(&obj, &JsValue::from_str("skyLight"), &sky_view).unwrap();
    js_sys::Reflect::set(&obj, &JsValue::from_str("blockLight"), &block_view).unwrap();
    js_sys::Reflect::set(&obj, &JsValue::from_str("bytesRead"),
        &JsValue::from_f64(result.bytes_read as f64)).unwrap();
    obj.into()
}

// ---------------------------------------------------------------------------
// Round-trip tests: fused path vs split path (parse → mesh in two steps).
// Verifies that the parser→mesher integration inside each fused function
// produces identical geometry to the existing split pipeline.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const NO_BLOCKS: &[u16] = &[];

    fn mesher_config(fixture_num_sections: usize) -> (i32, i32, i32, i32, i32, i32) {
        let world_min = -64;
        let world_max = 320;
        let col_height = fixture_num_sections as i32 * 16;
        (0, world_min, 0, col_height, world_min, world_max)
    }

    fn mesh_split_v18plus(parsed: &parser_v18plus::MapChunkResult, ns: u32) -> GeometryOutput {
        let (sx, sy, sz, sh, wmin, wmax) = mesher_config(ns as usize);
        Mesher::new(sx, sy, sz, sh, wmin, wmin, wmax, true, true, 15).generate(
            &parsed.block_states, &parsed.block_light, &parsed.sky_light, &parsed.biomes,
            NO_BLOCKS, NO_BLOCKS, NO_BLOCKS, NO_BLOCKS, NO_BLOCKS,
        )
    }

    fn mesh_split_v17(parsed: &parser_v16_v17::ChunkSectionsResult, sky: &[u8], blk: &[u8], ns: u32) -> GeometryOutput {
        let (sx, sy, sz, sh, wmin, wmax) = mesher_config(ns as usize);
        Mesher::new(sx, sy, sz, sh, wmin, wmin, wmax, true, true, 15).generate(
            &parsed.block_states, blk, sky, &parsed.biomes,
            NO_BLOCKS, NO_BLOCKS, NO_BLOCKS, NO_BLOCKS, NO_BLOCKS,
        )
    }

    #[test]
    fn roundtrip_fused_v18plus_single() {
        let fixture = "../chunk-packet-fixtures/fixtures/map_chunk/1.18.2/0_0.map_chunk.bin";
        let raw = std::fs::read(fixture).expect("read fixture");
        let flags = parser_v18plus::McVersionFlags::for_protocol(758);
        let ns: u32 = 24;
        let (sx, sy, sz, sh, wmin, wmax) = mesher_config(ns as usize);

        let parsed = parser_v18plus::parse_map_chunk_v18plus(
            &raw, ns as usize, 8, 3, flags,
        ).expect("parse");
        let split = mesh_split_v18plus(&parsed, ns);

        let fused = generate_geometry_from_map_chunk_v18plus_inner(
            &raw, ns, 8, 3, 758,
            sx, sy, sz, sh, wmin, wmax, wmin,
            NO_BLOCKS, NO_BLOCKS, NO_BLOCKS, NO_BLOCKS, NO_BLOCKS,
            true, true, 15,
        ).expect("fused");

        assert_eq!(fused.blocks.len(), split.blocks.len(), "blocks.len");
        assert_eq!(fused.block_count, split.block_count, "block_count");

        for (i, (fb, sb)) in fused.blocks.iter().zip(split.blocks.iter()).enumerate() {
            assert_eq!(fb.position, sb.position, "block[{}].position", i);
            assert_eq!(fb.block_state_id, sb.block_state_id, "block[{}].state_id", i);
            assert_eq!(fb.visible_faces, sb.visible_faces, "block[{}].faces", i);
            assert_eq!(fb.ao_data.len(), sb.ao_data.len(), "block[{}].ao_data.len", i);
            assert_eq!(fb.light_data.len(), sb.light_data.len(), "block[{}].light_data.len", i);
        }
    }

    #[test]
    fn roundtrip_fused_v17_single() {
        let fixture_path = "../chunk-packet-fixtures/fixtures-1.17/with_light.json";
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(fixture_path).expect("read fixture"))
                .expect("parse json");
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD;

        let chunk_data = b64.decode(json["chunkData_b64"].as_str().expect("chunkData_b64")).expect("decode chunkData");
        let bit_map_raw = json["bitMap_long"]
            .as_array().expect("bitMap_long")
            .iter()
            .map(|v| {
                let pair = v.as_array().expect("bitMap_long pair");
                [pair[0].as_u64().unwrap() as u32, pair[1].as_u64().unwrap() as u32]
            })
            .collect::<Vec<[u32; 2]>>();
        let bit_map: Vec<u32> = {
            let mut out = Vec::with_capacity(bit_map_raw.len() * 2);
            for &[hi, lo] in &bit_map_raw {
                out.push(lo);
                out.push(hi);
            }
            out
        };
        let biomes_str = json["biomes_int_b64"].as_str().unwrap_or("");
        let biomes_ints: Vec<i32> = if biomes_str.is_empty() {
            vec![]
        } else {
            let bytes = b64.decode(biomes_str).expect("decode biomes");
            bytes.chunks_exact(4).map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
        };
        let sky_b64 = json["light"]["sky_b64"].as_str().unwrap_or("");
        let sky_light = if sky_b64.is_empty() { vec![] } else { b64.decode(sky_b64).expect("decode sky") };
        let blk_b64 = json["light"]["block_b64"].as_str().unwrap_or("");
        let block_light = if blk_b64.is_empty() { vec![] } else { b64.decode(blk_b64).expect("decode block") };
        let ns: u32 = json["meta"]["numSections"].as_u64().unwrap() as u32;
        let default_biome: u8 = 1;
        let (sx, sy, sz, sh, wmin, wmax) = mesher_config(ns as usize);

        let cells_opt: Option<&[i32]> = if biomes_ints.is_empty() { None } else { Some(&biomes_ints) };
        let parsed = parser_v16_v17::parse_chunk_sections_v16_v17(
            &chunk_data, &bit_map, ns as usize, 15, cells_opt, default_biome,
        ).expect("parse v17");
        let total = parsed.block_states.len();
        let sky = if sky_light.len() == total { sky_light.clone() } else { vec![15u8; total] };
        let blk = if block_light.len() == total { block_light.clone() } else { vec![0u8; total] };

        let split = mesh_split_v17(&parsed, &sky, &blk, ns);

        let fused = generate_geometry_from_parsed_v16_v17_inner(
            &chunk_data, &bit_map, ns, 15,
            &biomes_ints, default_biome,
            &sky_light, &block_light,
            sx, sy, sz, sh, wmin, wmax, wmin,
            NO_BLOCKS, NO_BLOCKS, NO_BLOCKS, NO_BLOCKS, NO_BLOCKS,
            true, true, 15,
        ).expect("fused");

        assert_eq!(fused.blocks.len(), split.blocks.len(), "blocks.len");
        assert_eq!(fused.block_count, split.block_count, "block_count");

        for (i, (fb, sb)) in fused.blocks.iter().zip(split.blocks.iter()).enumerate() {
            assert_eq!(fb.position, sb.position, "block[{}].position", i);
            assert_eq!(fb.block_state_id, sb.block_state_id, "block[{}].state_id", i);
            assert_eq!(fb.visible_faces, sb.visible_faces, "block[{}].faces", i);
        }
    }

    #[test]
    fn roundtrip_fused_v18plus_multi_n1() {
        // Multi-fused with a single column must produce identical geometry
        // to single-fused (which is itself round-trip-validated against
        // the split path above).  This exercises the multi loop end-to-end.
        let fixture = "../chunk-packet-fixtures/fixtures/map_chunk/1.18.2/0_0.map_chunk.bin";
        let raw = std::fs::read(fixture).expect("read fixture");
        let ns: u32 = 24;
        let (sx, sy, sz, sh, wmin, wmax) = mesher_config(ns as usize);

        let single = generate_geometry_from_map_chunk_v18plus_inner(
            &raw, ns, 8, 3, 758,
            sx, sy, sz, sh, wmin, wmax, wmin,
            NO_BLOCKS, NO_BLOCKS, NO_BLOCKS, NO_BLOCKS, NO_BLOCKS,
            true, true, 15,
        ).expect("single fused");

        let raw_packets = vec![raw.clone()];
        let multi = generate_geometry_from_map_chunk_v18plus_multi_inner(
            &raw_packets,
            &[ns], 8, 3, 758,
            &[0], &[0],
            sx, sy, sz, sh, wmin, wmax, wmin,
            NO_BLOCKS, NO_BLOCKS, NO_BLOCKS, NO_BLOCKS, NO_BLOCKS,
            true, true, 15,
        ).expect("multi fused");

        assert_eq!(multi.blocks.len(), single.blocks.len(), "blocks.len");
        assert_eq!(multi.block_count, single.block_count, "block_count");
        for (i, (mb, sb)) in multi.blocks.iter().zip(single.blocks.iter()).enumerate() {
            assert_eq!(mb.position, sb.position, "block[{}].position", i);
            assert_eq!(mb.block_state_id, sb.block_state_id, "block[{}].state_id", i);
            assert_eq!(mb.visible_faces, sb.visible_faces, "block[{}].faces", i);
            assert_eq!(mb.ao_data.len(), sb.ao_data.len(), "block[{}].ao_data.len", i);
            assert_eq!(mb.light_data.len(), sb.light_data.len(), "block[{}].light_data.len", i);
        }
    }

    #[test]
    fn roundtrip_fused_v17_multi_n1() {
        let fixture_path = "../chunk-packet-fixtures/fixtures-1.17/with_light.json";
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(fixture_path).expect("read fixture"))
                .expect("parse json");
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD;

        let chunk_data = b64.decode(json["chunkData_b64"].as_str().expect("chunkData_b64")).expect("decode chunkData");
        let bit_map_raw = json["bitMap_long"]
            .as_array().expect("bitMap_long")
            .iter()
            .map(|v| {
                let pair = v.as_array().expect("bitMap_long pair");
                [pair[0].as_u64().unwrap() as u32, pair[1].as_u64().unwrap() as u32]
            })
            .collect::<Vec<[u32; 2]>>();
        let bit_map: Vec<u32> = {
            let mut out = Vec::with_capacity(bit_map_raw.len() * 2);
            for &[hi, lo] in &bit_map_raw {
                out.push(lo);
                out.push(hi);
            }
            out
        };
        let biomes_str = json["biomes_int_b64"].as_str().unwrap_or("");
        let biomes_ints: Vec<i32> = if biomes_str.is_empty() {
            vec![]
        } else {
            let bytes = b64.decode(biomes_str).expect("decode biomes");
            bytes.chunks_exact(4).map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
        };
        let sky_b64 = json["light"]["sky_b64"].as_str().unwrap_or("");
        let sky_light = if sky_b64.is_empty() { vec![] } else { b64.decode(sky_b64).expect("decode sky") };
        let blk_b64 = json["light"]["block_b64"].as_str().unwrap_or("");
        let block_light = if blk_b64.is_empty() { vec![] } else { b64.decode(blk_b64).expect("decode block") };
        let ns: u32 = json["meta"]["numSections"].as_u64().unwrap() as u32;
        let default_biome: u8 = 1;
        let (sx, sy, sz, sh, wmin, wmax) = mesher_config(ns as usize);

        let single = generate_geometry_from_parsed_v16_v17_inner(
            &chunk_data, &bit_map, ns, 15,
            &biomes_ints, default_biome,
            &sky_light, &block_light,
            sx, sy, sz, sh, wmin, wmax, wmin,
            NO_BLOCKS, NO_BLOCKS, NO_BLOCKS, NO_BLOCKS, NO_BLOCKS,
            true, true, 15,
        ).expect("single fused");

        let chunk_data_list = vec![chunk_data.clone()];
        let biomes_list = vec![biomes_ints.clone()];
        let sky_list = vec![sky_light.clone()];
        let block_list = vec![block_light.clone()];

        let multi = generate_geometry_from_parsed_v16_v17_multi_inner(
            &chunk_data_list, &bit_map, &[ns], 15,
            &biomes_list, default_biome,
            &sky_list, &block_list,
            &[0], &[0],
            sx, sy, sz, sh, wmin, wmax, wmin,
            NO_BLOCKS, NO_BLOCKS, NO_BLOCKS, NO_BLOCKS, NO_BLOCKS,
            true, true, 15,
        ).expect("multi fused");

        assert_eq!(multi.blocks.len(), single.blocks.len(), "blocks.len");
        assert_eq!(multi.block_count, single.block_count, "block_count");
        for (i, (mb, sb)) in multi.blocks.iter().zip(single.blocks.iter()).enumerate() {
            assert_eq!(mb.position, sb.position, "block[{}].position", i);
            assert_eq!(mb.block_state_id, sb.block_state_id, "block[{}].state_id", i);
            assert_eq!(mb.visible_faces, sb.visible_faces, "block[{}].faces", i);
        }
    }
}
