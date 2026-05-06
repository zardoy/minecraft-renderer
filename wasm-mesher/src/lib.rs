use wasm_bindgen::prelude::*;

mod chunk;
mod chunk_parser_common;
mod dump_parser;
mod geometry;
mod lighting;
mod mesher;
mod parser_v18plus;
mod parser_v17;
mod utils;

use chunk::ChunkData;
use mesher::Mesher;

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
#[wasm_bindgen(js_name = parseChunkSectionsV17)]
pub fn parse_chunk_sections_v17_js(
    chunk_data: &[u8],
    bit_map_lo_hi: &[u32],
    num_sections: u32,
    max_bits_per_block: u8,
    biomes_cells: &[i32],
    default_biome: u8,
) -> JsValue {
    let cells_opt: Option<&[i32]> = if biomes_cells.is_empty() { None } else { Some(biomes_cells) };
    let result = match parser_v17::parse_chunk_sections_v17(
        chunk_data,
        bit_map_lo_hi,
        num_sections as usize,
        max_bits_per_block,
        cells_opt,
        default_biome,
    ) {
        Ok(r) => r,
        Err(e) => wasm_bindgen::throw_str(&format!("parseChunkSectionsV17 error: {}", e)),
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
    let result = match parser_v17::parse_update_light_v17(raw_packet, num_sections as usize) {
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
