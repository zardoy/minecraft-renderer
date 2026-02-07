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
    // Get the three blocks that affect AO for this corner
    // Based on the face direction and corner position

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

    // Check if blocks are solid (non-transparent, non-air)
    let side1_solid = is_solid(world, side1_x, side1_y, side1_z);
    let side2_solid = is_solid(world, side2_x, side2_y, side2_z);
    let corner_solid = is_solid(world, corner_x, corner_y, corner_z);

    // AO calculation: if both sides are solid, darkest (0)
    // Otherwise: 3 - (side1 + side2 + corner)
    if side1_solid && side2_solid {
        0
    } else {
        3 - (side1_solid as u8 + side2_solid as u8 + corner_solid as u8)
    }
}

/// Check if a block is solid (non-transparent, non-air)
#[inline(always)]
fn is_solid(world: &WorldView<'_>, x: i32, y: i32, z: i32) -> bool {
    let state = world.get_block_state(x, y, z);
    state != 0 // TODO: Check against transparent blocks list
}

/// Calculate light value for a position
/// Returns light value (0-15)
#[inline(always)]
pub fn calculate_light(
    world: &WorldView<'_>,
    x: i32,
    y: i32,
    z: i32,
    face_dir: [i32; 3],
    face_idx: usize,
    corner_offset: [i32; 3],
    smooth_lighting: bool,
) -> f32 {
    let [fx, fy, fz] = face_dir;

    // Base light from the face neighbor
    let neighbor_x = x + fx;
    let neighbor_y = y + fy;
    let neighbor_z = z + fz;

    let base_block_light = world.get_block_light(neighbor_x, neighbor_y, neighbor_z) as f32;
    let base_sky_light = world.get_sky_light(neighbor_x, neighbor_y, neighbor_z) as f32;
    let base_light = base_block_light.max(base_sky_light);

    if !smooth_lighting {
        return base_light / 15.0;
    }

    let [cx, cy, cz] = corner_offset;

    let get_light = |x: i32, y: i32, z: i32| -> f32 {
        let bl = world.get_block_light(x, y, z) as f32;
        let sl = world.get_sky_light(x, y, z) as f32;
        bl.max(sl)
    };

    let mask1 = FACE_MASK1[face_idx];
    let mask2 = FACE_MASK2[face_idx];

    let mut s1 = [cx * mask1[0], cy * mask1[1], cz * mask1[2]];
    if fx != 0 {
        s1[0] = 0;
    }
    if fy != 0 {
        s1[1] = 0;
    }
    if fz != 0 {
        s1[2] = 0;
    }

    let mut s2 = [cx * mask2[0], cy * mask2[1], cz * mask2[2]];
    if fx != 0 {
        s2[0] = 0;
    }
    if fy != 0 {
        s2[1] = 0;
    }
    if fz != 0 {
        s2[2] = 0;
    }

    let mut c = [cx, cy, cz];
    if fx != 0 {
        c[0] = 0;
    }
    if fy != 0 {
        c[1] = 0;
    }
    if fz != 0 {
        c[2] = 0;
    }

    let lights = [
        base_light,
        get_light(x + fx + s1[0], y + fy + s1[1], z + fz + s1[2]),
        get_light(x + fx + s2[0], y + fy + s2[1], z + fz + s2[2]),
        get_light(x + fx + c[0], y + fy + c[1], z + fz + c[2]),
    ];

    // Average the lights
    let avg_light = (lights[0] + lights[1] + lights[2] + lights[3]) / 4.0;
    avg_light / 15.0
}

/// Calculate final color with AO and light
#[inline(always)]
pub fn calculate_color(
    base_color: [f32; 3], // RGB tint
    ao: u8,
    light: f32,
) -> [f32; 3] {
    // AO factor: 0 = 0.2, 1 = 0.4, 2 = 0.6, 3 = 1.0
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
