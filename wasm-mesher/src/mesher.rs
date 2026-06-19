use crate::chunk::{ChunkData, WorldView};
use crate::lighting::{calculate_light_channels, FACE_DIRS};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::rc::Rc;

const FACE_MASK1: [[i32; 3]; 6] = [
    [1, 1, 0],
    [1, 1, 0],
    [1, 1, 0],
    [1, 1, 0],
    [1, 0, 1],
    [1, 0, 1],
];

const FACE_MASK2: [[i32; 3]; 6] = [
    [0, 1, 1],
    [0, 1, 1],
    [1, 0, 1],
    [1, 0, 1],
    [0, 1, 1],
    [0, 1, 1],
];

#[derive(Clone, Copy, PartialEq, Eq)]
struct MetaKey {
    invisible_len: usize,
    transparent_len: usize,
    no_ao_len: usize,
    cull_identical_len: usize,
    occluding_len: usize,
}

struct MetaMaps {
    invisible: Vec<u8>,
    transparent: Vec<u8>,
    no_ao: Vec<u8>,
    cull_identical: Vec<u8>,
    occluding: Vec<u8>,
}

thread_local! {
    static META: RefCell<Option<(MetaKey, Rc<MetaMaps>)>> = RefCell::new(None);
}

fn get_meta(
    invisible_blocks: &[u16],
    transparent_blocks: &[u16],
    no_ao_blocks: &[u16],
    cull_identical_blocks: &[u16],
    occluding_blocks: &[u16],
) -> Rc<MetaMaps> {
    let key = MetaKey {
        invisible_len: invisible_blocks.len(),
        transparent_len: transparent_blocks.len(),
        no_ao_len: no_ao_blocks.len(),
        cull_identical_len: cull_identical_blocks.len(),
        occluding_len: occluding_blocks.len(),
    };

    META.with(|cell| {
        let cur = cell.borrow();
        if let Some((cur_key, maps)) = cur.as_ref() {
            if *cur_key == key {
                return maps.clone();
            }
        }
        drop(cur);

        let mut invisible = vec![0u8; 65536];
        let mut transparent = vec![0u8; 65536];
        let mut no_ao = vec![0u8; 65536];
        let mut cull_identical = vec![0u8; 65536];
        let mut occluding = vec![0u8; 65536];

        for &id in invisible_blocks {
            invisible[id as usize] = 1;
        }
        for &id in transparent_blocks {
            transparent[id as usize] = 1;
        }
        for &id in no_ao_blocks {
            no_ao[id as usize] = 1;
        }
        for &id in cull_identical_blocks {
            cull_identical[id as usize] = 1;
        }
        for &id in occluding_blocks {
            occluding[id as usize] = 1;
        }

        let maps = Rc::new(MetaMaps {
            invisible,
            transparent,
            no_ao,
            cull_identical,
            occluding,
        });

        *cell.borrow_mut() = Some((key, maps.clone()));
        maps
    })
}

pub struct Mesher {
    section_x: i32,
    section_y: i32,
    section_z: i32,
    section_height: i32,
    section_data_start_y: i32,
    world_min_y: i32,
    world_max_y: i32,
    enable_lighting: bool,
    smooth_lighting: bool,
    sky_light_value: u8,
}

/// Efficient block face data - only what's needed for rendering
#[derive(Clone, Serialize, Deserialize)]
pub struct BlockFaceData {
    pub position: [i32; 3],        // x, y, z
    pub block_state_id: u16,       // Block state ID for this block
    pub visible_faces: u8,         // Bitmask: bit 0=up, 1=down, 2=east, 3=west, 4=south, 5=north
    pub ao_data: Vec<[u8; 4]>,     // AO values for each visible face (4 corners per face)
    /// Per-corner block light (0-1), smooth-averaged 0-15 channel / 15.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub block_light_data: Vec<[f32; 4]>,
    /// Per-corner sky light (0-1), geometric 0-15 channel / 15 (not time-of-day clamped).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sky_light_data: Vec<[f32; 4]>,
    /// Nibble-packed per corner: high=sky4, low=block4 (shader combines with u_skyLevel).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub light_combined: Vec<[u8; 4]>,
    /// Deprecated combined f32 light — kept for serde compat; always empty in live path.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub light_data: Vec<[f32; 4]>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct GeometryOutput {
    pub blocks: Vec<BlockFaceData>,
    pub block_count: usize,
    pub block_iterations: u32,
    pub heightmap: Vec<i16>, // 256 elements (z*16+x), max non-invisible block Y per column, -32768 = none
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_blocks_found: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_blocks_with_faces: Option<u32>,
}

impl Mesher {
    pub fn new(
        section_x: i32,
        section_y: i32,
        section_z: i32,
        section_height: i32,
        section_data_start_y: i32,
        world_min_y: i32,
        world_max_y: i32,
        enable_lighting: bool,
        smooth_lighting: bool,
        sky_light_value: u8,
    ) -> Self {
        Self {
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
        }
    }

    fn generate_with_world(&self, world: &WorldView<'_>, meta: &MetaMaps) -> GeometryOutput {
        // Pre-allocate with estimated capacity
        let estimated_blocks = ((self.section_height * 16 * 16) / 4) as usize; // Rough estimate
        let mut blocks = Vec::with_capacity(estimated_blocks);

        // Heightmap: max non-invisible block Y per column (z*16+x), -32768 = no block found
        let mut heightmap = vec![-32768i16; 256];

        // Main loop: iterate through all blocks
        let mut block_iterations = 0u32;
        let mut blocks_found = 0u32;
        let mut blocks_with_faces = 0u32;
        for y in self.section_y..(self.section_y + self.section_height) {
            for z in self.section_z..(self.section_z + 16) {
                for x in self.section_x..(self.section_x + 16) {
                    block_iterations += 1;

                    let block_state = world.get_block_state(x, y, z);

                    if block_state == 0 || meta.invisible[block_state as usize] != 0 {
                        continue;
                    }

                    blocks_found += 1;

                    // Update heightmap - y increases in the outer loop so last write = highest y
                    let col_x = (x - self.section_x) as usize;
                    let col_z = (z - self.section_z) as usize;
                    heightmap[col_z * 16 + col_x] = y as i16;

                    let is_transparent = meta.transparent[block_state as usize] != 0;
                    let cull_identical = meta.cull_identical[block_state as usize] != 0;

                    // Check each face and collect visible ones
                    let mut visible_faces = 0u8;
                    let mut ao_data = Vec::new();
                    let mut block_light_data = Vec::new();
                    let mut sky_light_data = Vec::new();
                    let mut light_combined_data = Vec::new();

                    for (face_idx, face_dir) in FACE_DIRS.iter().enumerate() {
                        let neighbor_x = x + face_dir[0];
                        let neighbor_y = y + face_dir[1];
                        let neighbor_z = z + face_dir[2];
                        let neighbor_state =
                            world.get_block_state(neighbor_x, neighbor_y, neighbor_z);

                        // Determine if face should be culled
                        let should_cull = if neighbor_state == 0 {
                            false
                        } else if cull_identical && neighbor_state == block_state {
                            true
                        } else if meta.occluding[neighbor_state as usize] != 0 && !is_transparent {
                            true
                        } else {
                            false
                        };

                        if should_cull {
                            continue; // Face is culled
                        }

                        // Face is visible - mark it
                        visible_faces |= 1u8 << face_idx;

                        // Calculate AO and light for each corner of this face
                        let corners = crate::geometry::FACE_CORNERS[face_idx];
                        let mut face_ao = [0u8; 4];
                        let mut face_block_light = [0.0f32; 4];
                        let mut face_sky_light = [0.0f32; 4];
                        let mut face_light_combined = [0u8; 4];

                        for (corner_idx, corner) in corners.iter().enumerate() {
                            let corner_offset = [corner[0] * 2 - 1, corner[1] * 2 - 1, corner[2] * 2 - 1];

                            face_ao[corner_idx] = calculate_ao_with_set(
                                &world,
                                x,
                                y,
                                z,
                                face_idx,
                                corner_offset,
                                &meta.no_ao,
                                &meta.occluding,
                            );

                            if self.enable_lighting {
                                let ((block_f, sky_f), packed) = calculate_light_channels(
                                    &world,
                                    x,
                                    y,
                                    z,
                                    *face_dir,
                                    face_idx,
                                    corner_offset,
                                    self.smooth_lighting,
                                );
                                face_block_light[corner_idx] = block_f;
                                face_sky_light[corner_idx] = sky_f;
                                face_light_combined[corner_idx] = packed;
                            } else {
                                face_block_light[corner_idx] = 0.0;
                                face_sky_light[corner_idx] = 1.0;
                                face_light_combined[corner_idx] = 0xF0;
                            }
                        }

                        ao_data.push(face_ao);
                        block_light_data.push(face_block_light);
                        sky_light_data.push(face_sky_light);
                        light_combined_data.push(face_light_combined);
                    }

                    // Only add block if it has visible faces
                    if visible_faces != 0 {
                        blocks_with_faces += 1;
                        blocks.push(BlockFaceData {
                            position: [x, y, z],
                            block_state_id: block_state,
                            visible_faces,
                            ao_data,
                            block_light_data,
                            sky_light_data,
                            light_combined: light_combined_data,
                            light_data: Vec::new(),
                        });
                    }
                }
            }
        }

        let block_count = blocks.len();

        // Debug: Log summary (this will be visible in console if panics occur)
        // Note: In release builds with panic=abort, this won't help, but it's useful for debug builds
        let _ = format!(
            "WASM Mesher: iterations={}, blocks_found={}, blocks_with_faces={}, final_count={}",
            block_iterations, blocks_found, blocks_with_faces, block_count
        );

        GeometryOutput {
            blocks,
            block_count,
            block_iterations,
            heightmap,
            debug_blocks_found: Some(blocks_found),
            debug_blocks_with_faces: Some(blocks_with_faces),
        }
    }

    pub fn generate(
        &self,
        block_states: &[u16],
        block_light: &[u8],
        sky_light: &[u8],
        biomes: &[u8],
        invisible_blocks: &[u16],
        transparent_blocks: &[u16],
        no_ao_blocks: &[u16], // Block states that don't contribute to AO
        cull_identical_blocks: &[u16], // Block states that cull identical neighbors (glass, ice)
        occluding_blocks: &[u16],
    ) -> GeometryOutput {
        // Build world view from input data
        // chunk_data_height is derived from the actual data length, which may be larger than
        // section_height to include ±1 Y layers for correct cross-section boundary culling
        let chunk_data_height = (block_states.len() / (16 * 16)) as i32;
        let chunk = ChunkData {
            block_states,
            block_light,
            sky_light,
            biomes,
            chunk_x: self.section_x,
            chunk_z: self.section_z,
            world_min_y: self.section_data_start_y,
            world_height: chunk_data_height,
        };

        let world = WorldView::new(vec![chunk], self.world_min_y, self.world_max_y, self.sky_light_value);

        let meta = get_meta(
            invisible_blocks,
            transparent_blocks,
            no_ao_blocks,
            cull_identical_blocks,
            occluding_blocks,
        );

        self.generate_with_world(&world, meta.as_ref())
    }
    pub fn generate_multi<'a>(
        &self,
        chunks: Vec<ChunkData<'a>>,
        invisible_blocks: &'a [u16],
        transparent_blocks: &'a [u16],
        no_ao_blocks: &'a [u16],
        cull_identical_blocks: &'a [u16],
        occluding_blocks: &'a [u16],
    ) -> GeometryOutput {
        let world = WorldView::new(chunks, self.world_min_y, self.world_max_y, self.sky_light_value);
        let meta = get_meta(
            invisible_blocks,
            transparent_blocks,
            no_ao_blocks,
            cull_identical_blocks,
            occluding_blocks,
        );
        self.generate_with_world(&world, meta.as_ref())
    }
}

/// Calculate AO with no_ao_blocks set support
fn calculate_ao_with_set(
    world: &WorldView<'_>,
    x: i32,
    y: i32,
    z: i32,
    face_idx: usize,
    corner_offset: [i32; 3],
    no_ao_map: &[u8],
    occluding_map: &[u8],
) -> u8 {
    let [cx, cy, cz] = corner_offset;

    let mask1 = FACE_MASK1[face_idx];
    let mask2 = FACE_MASK2[face_idx];

    let side1_x = x + cx * mask1[0];
    let side1_y = y + cy * mask1[1];
    let side1_z = z + cz * mask1[2];

    let side2_x = x + cx * mask2[0];
    let side2_y = y + cy * mask2[1];
    let side2_z = z + cz * mask2[2];

    let corner_x = x + cx;
    let corner_y = y + cy;
    let corner_z = z + cz;

    let is_solid = |x: i32, y: i32, z: i32| -> bool {
        let state = world.get_block_state(x, y, z);
        state != 0 && occluding_map[state as usize] != 0 && no_ao_map[state as usize] == 0
    };

    let side1_solid = is_solid(side1_x, side1_y, side1_z);
    let side2_solid = is_solid(side2_x, side2_y, side2_z);
    let corner_solid = is_solid(corner_x, corner_y, corner_z);

    // AO calculation: if both sides are solid, darkest (0)
    // Otherwise: 3 - (side1 + side2 + corner)
    if side1_solid && side2_solid {
        0
    } else {
        3 - (side1_solid as u8 + side2_solid as u8 + corner_solid as u8)
    }
}
