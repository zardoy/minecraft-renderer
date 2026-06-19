use crate::chunk::WorldView;

/// Face directions (same as elemFaces in models.ts)
pub const FACE_DIRS: [[i32; 3]; 6] = [
    [0, 1, 0],  // up
    [0, -1, 0], // down
    [1, 0, 0],  // east
    [-1, 0, 0], // west
    [0, 0, 1],  // south
    [0, 0, -1], // north
];

pub const FACE_NAMES: [&str; 6] = ["up", "down", "east", "west", "south", "north"];

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

/// Calculate ambient occlusion for a vertex
/// Returns AO value (0-3, where 0 = darkest, 3 = brightest)
#[inline(always)]
pub fn calculate_ao(
    world: &WorldView<'_>,
    x: i32,
    y: i32,
    z: i32,
    face_dir: [i32; 3],
    corner_offset: [i32; 3], // Which corner of the face
) -> u8 {
    let [fx, fy, fz] = face_dir;
    let [cx, cy, cz] = corner_offset;

    let side1_x = x + if fx != 0 { 0 } else { cx };
    let side1_y = y + if fy != 0 { 0 } else { cy };
    let side1_z = z + if fz != 0 { 0 } else { cz };

    let side2_x = x + if fx != 0 { cx } else { 0 };
    let side2_y = y + if fy != 0 { cy } else { 0 };
    let side2_z = z + if fz != 0 { cz } else { 0 };

    let corner_x = x + cx;
    let corner_y = y + cy;
    let corner_z = z + cz;

    let side1_solid = is_solid(world, side1_x, side1_y, side1_z);
    let side2_solid = is_solid(world, side2_x, side2_y, side2_z);
    let corner_solid = is_solid(world, corner_x, corner_y, corner_z);

    if side1_solid && side2_solid {
        0
    } else {
        3 - (side1_solid as u8 + side2_solid as u8 + corner_solid as u8)
    }
}

#[inline(always)]
fn is_solid(world: &WorldView<'_>, x: i32, y: i32, z: i32) -> bool {
    let state = world.get_block_state(x, y, z);
    state != 0
}

#[inline(always)]
fn brighten_light_nibble(v: f32) -> f32 {
    (v + 2.0).min(15.0)
}

/// Sample block and sky light separately with optional smooth 4-corner averaging.
/// Returns (block_avg 0-15, sky_avg 0-15).
#[inline(always)]
fn calculate_light_channels_inner(
    world: &WorldView<'_>,
    x: i32,
    y: i32,
    z: i32,
    face_dir: [i32; 3],
    face_idx: usize,
    corner_offset: [i32; 3],
    smooth_lighting: bool,
) -> (f32, f32) {
    let [fx, fy, fz] = face_dir;

    let neighbor_x = x + fx;
    let neighbor_y = y + fy;
    let neighbor_z = z + fz;

    let base_block = brighten_light_nibble(world.get_block_light(neighbor_x, neighbor_y, neighbor_z) as f32);
    let base_sky = brighten_light_nibble(world.get_sky_light(neighbor_x, neighbor_y, neighbor_z) as f32);

    if !smooth_lighting {
        return (base_block, base_sky);
    }

    let [cx, cy, cz] = corner_offset;

    let get_block = |px: i32, py: i32, pz: i32| -> f32 {
        brighten_light_nibble(world.get_block_light(px, py, pz) as f32)
    };
    let get_sky = |px: i32, py: i32, pz: i32| -> f32 {
        brighten_light_nibble(world.get_sky_light(px, py, pz) as f32)
    };

    let mask1 = FACE_MASK1[face_idx];
    let mask2 = FACE_MASK2[face_idx];

    let mut s1 = [cx * mask1[0], cy * mask1[1], cz * mask1[2]];
    if fx != 0 { s1[0] = 0; }
    if fy != 0 { s1[1] = 0; }
    if fz != 0 { s1[2] = 0; }

    let mut s2 = [cx * mask2[0], cy * mask2[1], cz * mask2[2]];
    if fx != 0 { s2[0] = 0; }
    if fy != 0 { s2[1] = 0; }
    if fz != 0 { s2[2] = 0; }

    let mut c = [cx, cy, cz];
    if fx != 0 { c[0] = 0; }
    if fy != 0 { c[1] = 0; }
    if fz != 0 { c[2] = 0; }

    let sample_positions = [
        (neighbor_x, neighbor_y, neighbor_z),
        (x + fx + s1[0], y + fy + s1[1], z + fz + s1[2]),
        (x + fx + s2[0], y + fy + s2[1], z + fz + s2[2]),
        (x + fx + c[0], y + fy + c[1], z + fz + c[2]),
    ];

    let mut block_sum = 0.0f32;
    let mut sky_sum = 0.0f32;
    for &(px, py, pz) in &sample_positions {
        block_sum += get_block(px, py, pz);
        sky_sum += get_sky(px, py, pz);
    }

    (block_sum / 4.0, sky_sum / 4.0)
}

#[inline(always)]
fn clamp_nibble(v: f32) -> u8 {
    v.round().clamp(0.0, 15.0) as u8
}

/// Pack sky (high nibble) and block (low nibble) into one byte per corner.
#[inline(always)]
pub fn pack_light_nibbles(sky_avg: f32, block_avg: f32) -> u8 {
    let sky4 = clamp_nibble(sky_avg);
    let block4 = clamp_nibble(block_avg);
    (sky4 << 4) | block4
}

/// Per-corner lighting for live world rendering (shader combines at draw time).
/// Returns ((block_f32, sky_f32) normalized 0-1, nibble-packed byte).
#[inline(always)]
pub fn calculate_light_channels(
    world: &WorldView<'_>,
    x: i32,
    y: i32,
    z: i32,
    face_dir: [i32; 3],
    face_idx: usize,
    corner_offset: [i32; 3],
    smooth_lighting: bool,
) -> ((f32, f32), u8) {
    let (block_avg, sky_avg) = calculate_light_channels_inner(
        world, x, y, z, face_dir, face_idx, corner_offset, smooth_lighting,
    );
    let packed = pack_light_nibbles(sky_avg, block_avg);
    ((block_avg / 15.0, sky_avg / 15.0), packed)
}

/// Bake-time combined light for static export paths (no live u_skyLevel uniform).
#[inline(always)]
pub fn bake_clamped_combined_f32(block_avg: f32, sky_avg: f32, sky_light_value: u8) -> f32 {
    let effective_sky = sky_avg.min(sky_light_value as f32);
    block_avg.max(effective_sky) / 15.0
}

/// Bake-time packed byte for static export (combined max after time-of-day clamp on sky).
#[inline(always)]
pub fn bake_clamped_combined_packed(block_avg: f32, sky_avg: f32, sky_light_value: u8) -> u8 {
    let block4 = clamp_nibble(block_avg);
    let sky4 = clamp_nibble(sky_avg.min(sky_light_value as f32));
    let combined = block4.max(sky4);
    if combined >= 15 {
        255u8
    } else {
        (combined as f32 * 17.0).round() as u8
    }
}

/// Calculate final color with AO and light
#[inline(always)]
pub fn calculate_color(
    base_color: [f32; 3],
    ao: u8,
    light: f32,
) -> [f32; 3] {
    let ao_factor = match ao {
        0 => 0.2,
        1 => 0.4,
        2 => 0.6,
        3 => 1.0,
        _ => 1.0,
    };

    let final_factor = ao_factor * light;

    [
        base_color[0] * final_factor,
        base_color[1] * final_factor,
        base_color[2] * final_factor,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::{ChunkData, WorldView};

    fn brighten_nibble(v: u8) -> f32 {
        (v as f32 + 2.0).min(15.0)
    }

    fn make_world(block_light_val: u8, sky_light_val: u8) -> WorldView<'static> {
        let size = 16 * 16 * 3;
        let block_states: &'static [u16] = Vec::leak(vec![1u16; size]);
        let block_light: &'static [u8] = Vec::leak(vec![block_light_val; size]);
        let sky_light: &'static [u8] = Vec::leak(vec![sky_light_val; size]);
        let biomes: &'static [u8] = Vec::leak(vec![0u8; size]);

        let chunk = ChunkData {
            block_states,
            block_light,
            sky_light,
            biomes,
            chunk_x: 0,
            chunk_z: 0,
            world_min_y: 0,
            world_height: 3,
        };

        WorldView::new(vec![chunk], 0, 3, 15)
    }

    #[test]
    fn non_smooth_separate_channels() {
        let world = make_world(8, 12);
        let ((block_f, sky_f), packed) = calculate_light_channels(
            &world, 1, 0, 1,
            [0, 1, 0], 0, [-1, 1, -1],
            false,
        );
        assert!((block_f - brighten_nibble(8) / 15.0).abs() < 0.001, "block_f={}", block_f);
        assert!((sky_f - brighten_nibble(12) / 15.0).abs() < 0.001, "sky_f={}", sky_f);
        assert_eq!(packed, (brighten_nibble(12) as u8) << 4 | brighten_nibble(8) as u8);
    }

    #[test]
    fn smooth_uniform_channels() {
        let world = make_world(8, 0);
        let ((block_f, sky_f), packed) = calculate_light_channels(
            &world, 1, 0, 1,
            [0, 1, 0], 0, [-1, 1, -1],
            true,
        );
        assert!((block_f - brighten_nibble(8) / 15.0).abs() < 0.001);
        assert!((sky_f - brighten_nibble(0) / 15.0).abs() < 0.001);
        assert_eq!(packed, (brighten_nibble(0) as u8) << 4 | brighten_nibble(8) as u8);
    }

    #[test]
    fn smooth_nonuniform_sky() {
        let world = make_world(9, 0);
        let ((block_f, sky_f), _packed) = calculate_light_channels(
            &world, 0, 0, 0,
            [0, 1, 0], 0, [-1, 1, 1],
            true,
        );
        // block: inside=9, outside=0 → avg=4.5 raw, 6.5 after +2 per sample
        // sky: inside=0, outside=15 → avg=7.5 raw, 8.5 after +2 per sample
        assert!((block_f - 6.5 / 15.0).abs() < 0.001, "block_f={}", block_f);
        assert!((sky_f - 8.5 / 15.0).abs() < 0.001, "sky_f={}", sky_f);
    }

    #[test]
    fn all_zeros() {
        let world = make_world(0, 0);
        let ((block_f, sky_f), packed) = calculate_light_channels(
            &world, 1, 0, 1,
            [0, 1, 0], 0, [-1, 1, -1],
            true,
        );
        assert!((block_f - brighten_nibble(0) / 15.0).abs() < 0.001);
        assert!((sky_f - brighten_nibble(0) / 15.0).abs() < 0.001);
        assert_eq!(packed, (brighten_nibble(0) as u8) << 4 | brighten_nibble(0) as u8);
    }

    #[test]
    fn full_sky_nibble_pack() {
        let world = make_world(0, 15);
        let ((block_f, sky_f), packed) = calculate_light_channels(
            &world, 1, 0, 1,
            [0, 1, 0], 0, [-1, 1, -1],
            true,
        );
        assert!((block_f - brighten_nibble(0) / 15.0).abs() < 0.001);
        assert!((sky_f - brighten_nibble(15) / 15.0).abs() < 0.001);
        assert_eq!(packed, (brighten_nibble(15) as u8) << 4 | brighten_nibble(0) as u8);
    }

    #[test]
    fn bake_clamp_reduces_night_sky() {
        let combined = bake_clamped_combined_f32(0.0, 15.0, 4);
        assert!((combined - 4.0 / 15.0).abs() < 0.001, "combined={}", combined);
        let packed = bake_clamped_combined_packed(0.0, 15.0, 4);
        assert_eq!(packed, 4 * 17);
    }

    #[test]
    fn pack_nibbles_independent() {
        assert_eq!(pack_light_nibbles(15.0, 5.0), 0xF5);
        assert_eq!(pack_light_nibbles(0.0, 0.0), 0);
    }
}
