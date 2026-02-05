use crate::chunk::{ChunkData, WorldView};
use crate::lighting::{calculate_light, FACE_DIRS};
use serde::{Deserialize, Serialize};

pub struct Mesher {
    section_x: i32,
    section_y: i32,
    section_z: i32,
    section_height: i32,
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
    pub light_data: Vec<[f32; 4]>, // Light values for each visible face (4 corners per face)
}

#[derive(Clone, Serialize, Deserialize)]
pub struct GeometryOutput {
    pub blocks: Vec<BlockFaceData>,
    pub block_count: usize,
    pub block_iterations: u32,
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
            world_min_y,
            world_max_y,
            enable_lighting,
            smooth_lighting,
            sky_light_value,
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
        let chunk = ChunkData {
            block_states: block_states.to_vec(),
            block_light: block_light.to_vec(),
            sky_light: sky_light.to_vec(),
            biomes: biomes.to_vec(),
            chunk_x: self.section_x,
            chunk_z: self.section_z,
            world_min_y: self.section_y,
            world_height: self.section_height,
        };

        let world = WorldView::new(vec![chunk], self.world_min_y, self.world_max_y);

        // Build sets for fast lookup
        let invisible_set: std::collections::HashSet<u16> =
            invisible_blocks.iter().cloned().collect();
        let transparent_set: std::collections::HashSet<u16> =
            transparent_blocks.iter().cloned().collect();
        let no_ao_set: std::collections::HashSet<u16> = no_ao_blocks.iter().cloned().collect();
        let cull_identical_set: std::collections::HashSet<u16> =
            cull_identical_blocks.iter().cloned().collect();
        let occluding_set: std::collections::HashSet<u16> = occluding_blocks.iter().cloned().collect();

        // Pre-allocate with estimated capacity
        let estimated_blocks = ((self.section_height * 16 * 16) / 4) as usize; // Rough estimate
        let mut blocks = Vec::with_capacity(estimated_blocks);

        // Main loop: iterate through all blocks
        let mut block_iterations = 0u32;
        let mut blocks_found = 0u32;
        let mut blocks_with_faces = 0u32;
        for y in self.section_y..(self.section_y + self.section_height) {
            for z in self.section_z..(self.section_z + 16) {
                for x in self.section_x..(self.section_x + 16) {
                    block_iterations += 1;

                    let block_state = world.get_block_state(x, y, z);

                    // Skip air and invisible blocks
                    if block_state == 0 || invisible_set.contains(&block_state) {
                        continue;
                    }

                    blocks_found += 1;

                    let is_transparent = transparent_set.contains(&block_state);
                    let cull_identical = cull_identical_set.contains(&block_state);

                    // Check each face and collect visible ones
                    let mut visible_faces = 0u8;
                    let mut ao_data = Vec::new();
                    let mut light_data = Vec::new();

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
                        } else if occluding_set.contains(&neighbor_state) && !is_transparent {
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
                        let mut face_light = [0.0f32; 4];

                        for (corner_idx, corner) in corners.iter().enumerate() {
                            let corner_offset = [corner[0], corner[1], corner[2]];

                            // Calculate AO
                            face_ao[corner_idx] = calculate_ao_with_set(
                                &world,
                                x,
                                y,
                                z,
                                *face_dir,
                                corner_offset,
                                &no_ao_set,
                            );

                            // Calculate light
                            if self.enable_lighting {
                                face_light[corner_idx] = calculate_light(
                                    &world,
                                    x,
                                    y,
                                    z,
                                    *face_dir,
                                    corner_offset,
                                    self.smooth_lighting,
                                );
                            } else {
                                face_light[corner_idx] = 1.0;
                            }
                        }

                        ao_data.push(face_ao);
                        light_data.push(face_light);
                    }

                    // Only add block if it has visible faces
                    if visible_faces != 0 {
                        blocks_with_faces += 1;
                        blocks.push(BlockFaceData {
                            position: [x, y, z],
                            block_state_id: block_state,
                            visible_faces,
                            ao_data,
                            light_data,
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
            debug_blocks_found: Some(blocks_found),
            debug_blocks_with_faces: Some(blocks_with_faces),
        }
    }
}

/// Calculate AO with no_ao_blocks set support
fn calculate_ao_with_set(
    world: &WorldView,
    x: i32,
    y: i32,
    z: i32,
    face_dir: [i32; 3],
    corner_offset: [i32; 3],
    no_ao_set: &std::collections::HashSet<u16>,
) -> u8 {
    let [fx, fy, fz] = face_dir;
    let [cx, cy, cz] = corner_offset;

    // Calculate side block positions
    let side1_x = x + if fx != 0 { 0 } else { cx };
    let side1_y = y + if fy != 0 { 0 } else { cy };
    let side1_z = z + if fz != 0 { 0 } else { cz };

    let side2_x = x + if fx != 0 { cx } else { 0 };
    let side2_y = y + if fy != 0 { cy } else { 0 };
    let side2_z = z + if fz != 0 { cz } else { 0 };

    let corner_x = x + cx;
    let corner_y = y + cy;
    let corner_z = z + cz;

    // Check if blocks are solid (non-transparent, non-air, and not in no_ao_set)
    let is_solid = |x: i32, y: i32, z: i32| -> bool {
        let state = world.get_block_state(x, y, z);
        state != 0 && !no_ao_set.contains(&state)
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
