use crate::lighting::{calculate_color, FACE_DIRS};

/// Face corner positions (4 corners per face)
/// Format: [x, y, z, u, v] where u,v are UV coordinates
pub const FACE_CORNERS: [[[i32; 5]; 4]; 6] = [
    // up
    [
        [0, 1, 1, 0, 1],
        [1, 1, 1, 1, 1],
        [0, 1, 0, 0, 0],
        [1, 1, 0, 1, 0],
    ],
    // down
    [
        [1, 0, 1, 0, 1],
        [0, 0, 1, 1, 1],
        [1, 0, 0, 0, 0],
        [0, 0, 0, 1, 0],
    ],
    // east
    [
        [1, 1, 1, 0, 0],
        [1, 0, 1, 0, 1],
        [1, 1, 0, 1, 0],
        [1, 0, 0, 1, 1],
    ],
    // west
    [
        [0, 1, 0, 0, 0],
        [0, 0, 0, 0, 1],
        [0, 1, 1, 1, 0],
        [0, 0, 1, 1, 1],
    ],
    // south
    [
        [0, 0, 1, 0, 1],
        [1, 0, 1, 1, 1],
        [0, 1, 1, 0, 0],
        [1, 1, 1, 1, 0],
    ],
    // north
    [
        [1, 0, 0, 1, 1],
        [0, 0, 0, 0, 1],
        [1, 1, 0, 1, 0],
        [0, 1, 0, 0, 0],
    ],
];

pub struct GeometryBuilder {
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub colors: Vec<f32>,
    pub uvs: Vec<f32>,
    pub indices: Vec<u32>,
    pub current_index: u32,
}

impl GeometryBuilder {
    pub fn new(estimated_vertices: usize) -> Self {
        Self {
            positions: Vec::with_capacity(estimated_vertices * 3),
            normals: Vec::with_capacity(estimated_vertices * 3),
            colors: Vec::with_capacity(estimated_vertices * 3),
            uvs: Vec::with_capacity(estimated_vertices * 2),
            indices: Vec::with_capacity(estimated_vertices * 3 / 2), // ~1.5 indices per vertex
            current_index: 0,
        }
    }

    /// Add a face (4 vertices, 2 triangles)
    pub fn add_face(
        &mut self,
        x: i32,
        y: i32,
        z: i32,
        face_idx: usize,
        base_color: [f32; 3],
        ao_values: [u8; 4],
        light_values: [f32; 4],
        texture_u: f32,
        texture_v: f32,
        texture_su: f32,
        texture_sv: f32,
    ) {
        let face_dir = FACE_DIRS[face_idx];
        let corners = FACE_CORNERS[face_idx];
        let base_idx = self.current_index;

        // Add 4 vertices
        for (corner_idx, corner) in corners.iter().enumerate() {
            // Position (in block coordinates, 0-16)
            let px = (corner[0] as f32) / 16.0;
            let py = (corner[1] as f32) / 16.0;
            let pz = (corner[2] as f32) / 16.0;

            // World position
            self.positions.push(px + (x & 15) as f32 - 8.0);
            self.positions.push(py + (y & 15) as f32 - 8.0);
            self.positions.push(pz + (z & 15) as f32 - 8.0);

            // Normal
            self.normals.push(face_dir[0] as f32);
            self.normals.push(face_dir[1] as f32);
            self.normals.push(face_dir[2] as f32);

            // Color (with AO and light)
            let color =
                calculate_color(base_color, ao_values[corner_idx], light_values[corner_idx]);
            self.colors.push(color[0]);
            self.colors.push(color[1]);
            self.colors.push(color[2]);

            // UV
            let u = (corner[3] as f32) * texture_su + texture_u;
            let v = (corner[4] as f32) * texture_sv + texture_v;
            self.uvs.push(u);
            self.uvs.push(v);

            self.current_index += 1;
        }

        // Add indices (2 triangles)
        // Triangle 1
        self.indices.push(base_idx);
        self.indices.push(base_idx + 1);
        self.indices.push(base_idx + 2);

        // Triangle 2
        self.indices.push(base_idx);
        self.indices.push(base_idx + 2);
        self.indices.push(base_idx + 3);
    }
}
