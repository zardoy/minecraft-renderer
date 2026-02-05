use wasm_bindgen::prelude::*;

mod chunk;
mod geometry;
mod lighting;
mod mesher;
mod utils;

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
    // Section bounds
    section_x: i32,
    section_y: i32,
    section_z: i32,
    section_height: i32,

    // World config
    world_min_y: i32,
    world_max_y: i32,

    // Chunk data (as TypedArrays from JS)
    block_states: &[u16],
    block_light: &[u8],
    sky_light: &[u8],
    biomes: &[u8],

    // Block metadata
    invisible_blocks: &[u16],
    transparent_blocks: &[u16],
    no_ao_blocks: &[u16],          // Block states that don't contribute to AO
    cull_identical_blocks: &[u16], // Block states that cull identical neighbors (glass, ice)
    occluding_blocks: &[u16],

    // Config
    enable_lighting: bool,
    smooth_lighting: bool,
    sky_light_value: u8,
) -> JsValue {
    let mesher = Mesher::new(
        section_x,
        section_y,
        section_z,
        section_height,
        world_min_y,
        world_max_y,
        enable_lighting,
        smooth_lighting,
        sky_light_value,
    );

    // Validate input array lengths
    let expected_size = (section_height * 16 * 16) as usize;
    if block_states.len() < expected_size {
        let err_msg = format!(
            "block_states length < expected: expected {}, got {}",
            expected_size,
            block_states.len()
        );
        wasm_bindgen::throw_str(&err_msg);
    }

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

    // Convert to JS object using serde-wasm-bindgen
    // Use expect instead of unwrap for better error messages
    serde_wasm_bindgen::to_value(&result).expect("Failed to serialize geometry output to JS value")
}
