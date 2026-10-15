// Parser for the Minecraft 1.17 (protocol 756) chunk-section payload.
//
// 1.17's `map_chunk` packet differs from 1.18+ in several places (biomes are a
// flat int array in the prefix, light arrives in a separate `update_light`
// packet, etc.), but the *hot* portion — the actual block-state payload inside
// `chunkData` — is well-defined and isolated. This module decodes that hot
// portion only:
//
//   chunkData layout (per section, repeated for each set bit in `bitMap`):
//     - solidBlockCount: i16 BE          (informational, unused here)
//     - bitsPerBlock:    u8
//     - if bitsPerBlock <= MAX_BITS_PER_BLOCK (8):
//         - palette_len: VarInt
//         - palette:     VarInt[palette_len]   (block-state ids)
//         - data_len:    VarInt                (number of i64 longs)
//         - data:        long[data_len]        (packed indices, BitArrayNoSpan layout)
//       (bitsPerValue used to read `data` is `bitsPerBlock` itself.)
//     - else:
//         - data_len:    VarInt
//         - data:        long[data_len]
//       (bitsPerValue used to read `data` is `max_bits_per_block` — i.e. 1.17's
//        ChunkColumn `maxBitsPerBlock`, which is 15 in prismarine-chunk.)
//
// Despite its name, prismarine-chunk's 1.17 ChunkColumn imports
// `BitArrayNoSpan` (see src/pc/1.17/ChunkColumn.js line 2 — `const BitArray =
// require('../common/BitArrayNoSpan')`), so values never cross 64-bit
// boundaries. We reuse `bit_array_no_span_get` from `chunk_parser_common`.
//
// `bit_map` is the section-mask: a long-array with bit `s` set iff section `s`
// is present in `chunk_data`. It is shaped as pairs of (low, high) u32 per
// long, matching prismarine BitArray.toLongArray after the standard flip.

use std::io;

use crate::chunk_parser_common as common;

/// 1.17 ChunkColumn's `maxBitsPerBlock` — the bpv used for direct (global)
/// palette sections. Source: prismarine-chunk
/// src/pc/1.17/ChunkColumn.js → constructor default.
pub const MAX_BITS_PER_BLOCK_V17: u8 = 15;

/// 1.17 fixed worldHeight = 256 → 16 sections per column.
pub const NUM_SECTIONS_V17: usize = 16;

/// Decode the chunk-data payload of a 1.17 map_chunk packet.
///
/// `chunk_data` is the bytes between the `chunkData` length prefix and the
/// `blockEntities` count in the wire packet (i.e. exactly what
/// `prismarine-chunk` 1.17 `ChunkColumn.load(data, bitMap)` consumes).
///
/// `bit_map` is the section-mask flattened to `[low0, high0, low1, high1, ...]`
/// u32 pairs — same layout as `chunk_parser_common::mask_bit_get` expects.
///
/// `biomes_cells` (optional) is the 1.17 wire `biomes` field — varint[] of
/// `num_sections * 64` cell ids (4×4×4 per section). When provided, the
/// returned `biomes` is expanded to per-block (`num_sections * 4096` u8s).
/// When absent, `biomes` is filled with the `default_biome` value.
///
/// Returns `block_states` and `biomes` of length `num_sections * 4096`, laid out as
/// `idx = (s * 4096) + ((y_in << 8) | (z << 4) | x)` — i.e. per-section flat
/// stack, matching what the WASM mesher already consumes for 1.18+ blocks.
/// Sections whose bit is not set in `bit_map` are left as zeros (air).
///
/// Also returns `bytes_read` so callers can sanity-check they consumed the
/// whole `chunk_data` slice.
pub fn parse_chunk_sections_v16_v17(
    chunk_data: &[u8],
    bit_map: &[u32],
    num_sections: usize,
    max_bits_per_block: u8,
    biomes_cells: Option<&[i32]>,
    default_biome: u8,
) -> io::Result<ChunkSectionsResult> {
    let mut r = common::PacketReader::new(chunk_data);
    let total = num_sections * common::BLOCK_SECTION_VOLUME;
    let mut block_states = vec![0u16; total];

    for s in 0..num_sections {
        if !common::mask_bit_get(bit_map, s) {
            continue;
        }

        let _solid_block_count = r.read_i16_be()?;
        let bits_per_block = r.read_u8()?;

        let (palette, bpv_for_data) = if bits_per_block <= common::MAX_BITS_PER_BLOCK {
            let palette_len = r.read_varint()? as usize;
            let mut palette = Vec::with_capacity(palette_len);
            for _ in 0..palette_len {
                palette.push(r.read_varint()? as u32);
            }
            // For bits_per_block == 0 the upstream loader still treats it as
            // an indirect palette; the data array will then have 0 longs and
            // every cell decodes to palette[0]. Snap bpv to at least 1 so
            // values_per_long doesn't divide by zero. (Not observed in our
            // fixtures since the fork snaps to >=4, but be safe.)
            let bpv = if bits_per_block == 0 { 1 } else { bits_per_block };
            (Some(palette), bpv)
        } else {
            (None, max_bits_per_block)
        };

        let data_len = r.read_varint()? as usize;
        let data = common::read_bit_array_longs_no_span(&mut r, data_len)?;
        let value_mask = if bpv_for_data >= 32 {
            u32::MAX
        } else {
            (1u32 << bpv_for_data) - 1
        };
        let values_per_long = (64 / bpv_for_data as usize).max(1);

        let base = s * common::BLOCK_SECTION_VOLUME;
        if let Some(pal) = &palette {
            for i in 0..common::BLOCK_SECTION_VOLUME {
                let idx = common::bit_array_no_span_get(
                    &data, bpv_for_data, values_per_long, value_mask, i,
                ) as usize;
                block_states[base + i] = pal.get(idx).copied().unwrap_or(0) as u16;
            }
        } else {
            for i in 0..common::BLOCK_SECTION_VOLUME {
                let v = common::bit_array_no_span_get(
                    &data, bpv_for_data, values_per_long, value_mask, i,
                );
                block_states[base + i] = v as u16;
            }
        }
    }

    Ok(ChunkSectionsResult {
        block_states,
        biomes: expand_biomes_v17(biomes_cells, num_sections, default_biome),
        bytes_read: r.position(),
        bytes_total: chunk_data.len(),
    })
}

/// Expand 1.17 wire `biomes` (varint[num_sections * 64] of cell ids, 4×4×4 per
/// section) into per-block u8 array, matching prismarine-chunk's
/// `getBiome(pos)`: `cell_id = cells[(y_abs >> 2) << 4 | (z >> 2) << 2 | (x >> 2)]`.
///
/// Output layout matches `block_states`: `(s * 4096) | (y_in << 8) | (z << 4) | x`.
/// Length: `num_sections * 4096`.
///
/// When `cells` is `None` (mineflayer didn't send a biomes array), every block
/// gets `default_biome` (legacy behaviour: 1 = plains).
pub fn expand_biomes_v17(cells: Option<&[i32]>, num_sections: usize, default_biome: u8) -> Vec<u8> {
    let total = num_sections * common::BLOCK_SECTION_VOLUME;
    let mut biomes = vec![default_biome; total];
    let Some(cells) = cells else { return biomes };
    let expected_cells = num_sections * 64;
    if cells.len() != expected_cells {
        // Mismatched payload: fall back to default rather than indexing OOB.
        // (Helps us survive odd protocol variants without crashing the worker.)
        return biomes;
    }
    for s in 0..num_sections {
        let base = s * common::BLOCK_SECTION_VOLUME;
        let y_abs0 = s * 16;
        for y_in in 0..16usize {
            let y4 = (y_abs0 + y_in) >> 2;
            for z in 0..16usize {
                let z4 = z >> 2;
                let row_yz = base | (y_in << 8) | (z << 4);
                for x in 0..16usize {
                    let x4 = x >> 2;
                    let cell_idx = (y4 << 4) | (z4 << 2) | x4;
                    biomes[row_yz | x] = (cells[cell_idx] & 0xFF) as u8;
                }
            }
        }
    }
    biomes
}

#[derive(Debug)]
pub struct ChunkSectionsResult {
    /// `num_sections * 4096`, layout `(s * 4096) | (y_in << 8) | (z << 4) | x`.
    pub block_states: Vec<u16>,
    /// Same length and layout as `block_states`. Per-block biome ids expanded
    /// from the 4×4×4 wire cells, or `default_biome` if no cells were given.
    pub biomes: Vec<u8>,
    #[allow(dead_code)]
    pub bytes_read: usize,
    #[allow(dead_code)]
    pub bytes_total: usize,
}

/// Result of parsing a 1.17 `update_light` packet.
#[derive(Debug)]
pub struct UpdateLightV17Result {
    pub x: i32,
    pub z: i32,
    pub trust_edges: bool,
    /// `num_sections * 4096`, layout `idx = x + z*16 + y_abs*256`.
    /// Omitted sections are left 0 and are **not** authoritative — use the masks.
    pub sky_light: Vec<u8>,
    /// Same shape as `sky_light`.
    pub block_light: Vec<u8>,
    pub sky_light_mask: Vec<u32>,
    pub empty_sky_light_mask: Vec<u32>,
    pub block_light_mask: Vec<u32>,
    pub empty_block_light_mask: Vec<u32>,
    pub sky_below: Option<Vec<u8>>,
    pub sky_above: Option<Vec<u8>>,
    pub block_below: Option<Vec<u8>>,
    pub block_above: Option<Vec<u8>>,
    /// Total bytes consumed from the input packet (including the leading
    /// packet-id varint).
    pub bytes_read: usize,
}

/// Parse a raw 1.17 `update_light` packet (as captured by
/// `client.on('raw.update_light', ...)`).
///
/// Wire layout (minecraft-data pc/1.17 packet_update_light):
///   - chunkX:               VarInt
///   - chunkZ:               VarInt
///   - trustEdges:           bool
///   - skyLightMask:         VarInt count + i64[]
///   - blockLightMask:       VarInt count + i64[]
///   - emptySkyLightMask:    VarInt count + i64[]
///   - emptyBlockLightMask:  VarInt count + i64[]
///   - skyLight:             VarInt count + array of (VarInt size + bytes[size])
///   - blockLight:           VarInt count + array of (VarInt size + bytes[size])
///
/// This is byte-identical to the light tail of the 1.18+ `map_chunk` packet,
/// so we reuse `chunk_parser_common::{read_i64_array, read_light_arrays,
/// build_full_column_light}` directly.
pub fn parse_update_light_v17(
    packet: &[u8],
    num_sections: usize,
) -> io::Result<UpdateLightV17Result> {
    let mut r = common::PacketReader::new(packet);

    // Skip leading packet-id varint (raw.* listeners include it).
    let _packet_id = r.read_varint()?;

    let x = r.read_varint()?;
    let z = r.read_varint()?;
    let trust_edges = r.read_u8()? != 0;

    let sky_light_mask = common::read_i64_array(&mut r)?;
    let block_light_mask = common::read_i64_array(&mut r)?;
    let empty_sky_light_mask = common::read_i64_array(&mut r)?;
    let empty_block_light_mask = common::read_i64_array(&mut r)?;

    let sky_light_sections = common::read_light_arrays(&mut r)?;
    let block_light_sections = common::read_light_arrays(&mut r)?;

    let bytes_read = r.position();

    let sky_assembled = common::build_light_with_padding(
        &sky_light_sections,
        &sky_light_mask,
        &empty_sky_light_mask,
        num_sections,
        false,
    )?;
    let block_assembled = common::build_light_with_padding(
        &block_light_sections,
        &block_light_mask,
        &empty_block_light_mask,
        num_sections,
        false,
    )?;

    Ok(UpdateLightV17Result {
        x,
        z,
        trust_edges,
        sky_light: sky_assembled.world,
        block_light: block_assembled.world,
        sky_light_mask: common::i64_mask_to_u32_pairs(&sky_light_mask),
        empty_sky_light_mask: common::i64_mask_to_u32_pairs(&empty_sky_light_mask),
        block_light_mask: common::i64_mask_to_u32_pairs(&block_light_mask),
        empty_block_light_mask: common::i64_mask_to_u32_pairs(&empty_block_light_mask),
        sky_below: sky_assembled.below,
        sky_above: sky_assembled.above,
        block_below: block_assembled.below,
        block_above: block_assembled.above,
        bytes_read,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    use serde::Deserialize;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn fixtures_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../chunk-packet-fixtures/fixtures-1.17")
    }

    #[derive(Deserialize)]
    struct Meta {
        #[serde(rename = "numSections")] num_sections: usize,
        #[serde(rename = "maxBitsPerBlock")] max_bits_per_block: u8,
        #[serde(rename = "minY")] _min_y: i32,
        #[serde(rename = "worldHeight")] _world_height: i32,
    }

    #[derive(Deserialize)]
    struct Reference {
        #[serde(rename = "blockStates_b64")] block_states_b64: String,
        #[serde(rename = "biomesPerBlock_b64")] biomes_per_block_b64: String,
    }

    #[derive(Deserialize)]
    struct Fixture {
        name: String,
        meta: Meta,
        #[serde(rename = "chunkData_b64")] chunk_data_b64: String,
        #[serde(rename = "bitMap_long")] bit_map_long: Vec<[u32; 2]>,
        #[serde(rename = "biomes_int_b64")] biomes_int_b64: String,
        reference: Reference,
    }

    /// Convert prismarine `[hi, lo]` long-array to the flat `[lo, hi, lo, hi, ...]`
    /// u32 layout that `mask_bit_get` expects.
    fn bit_map_to_u32_pairs(longs: &[[u32; 2]]) -> Vec<u32> {
        let mut out = Vec::with_capacity(longs.len() * 2);
        for &[hi, lo] in longs {
            out.push(lo);
            out.push(hi);
        }
        out
    }

    /// Fixtures store `block_states_b64` as the natural-order (per-block) array
    /// the generator built: `idx = y_abs * 256 + z * 16 + x`. The parser
    /// produces a per-section stacked layout. Reorder reference into the same
    /// per-section layout before comparing.
    fn reorder_reference_to_section_layout(refs: &[u16], num_sections: usize) -> Vec<u16> {
        let mut out = vec![0u16; num_sections * common::BLOCK_SECTION_VOLUME];
        for s in 0..num_sections {
            for y_in in 0..16usize {
                let y_abs = s * 16 + y_in;
                for z in 0..16usize {
                    for x in 0..16usize {
                        let ref_idx = y_abs * 256 + z * 16 + x;
                        let dst = s * common::BLOCK_SECTION_VOLUME + ((y_in << 8) | (z << 4) | x);
                        out[dst] = refs[ref_idx];
                    }
                }
            }
        }
        out
    }

    fn reorder_reference_u8_to_section_layout(refs: &[u8], num_sections: usize) -> Vec<u8> {
        let mut out = vec![0u8; num_sections * common::BLOCK_SECTION_VOLUME];
        for s in 0..num_sections {
            for y_in in 0..16usize {
                let y_abs = s * 16 + y_in;
                for z in 0..16usize {
                    for x in 0..16usize {
                        let ref_idx = y_abs * 256 + z * 16 + x;
                        let dst = s * common::BLOCK_SECTION_VOLUME + ((y_in << 8) | (z << 4) | x);
                        out[dst] = refs[ref_idx];
                    }
                }
            }
        }
        out
    }

    fn run_one(path: &Path) {
        let bytes = fs::read(path).expect("fixture read");
        let fix: Fixture = serde_json::from_slice(&bytes).expect("fixture parse");

        let chunk_data = B64.decode(&fix.chunk_data_b64).expect("chunk_data b64");
        let bit_map = bit_map_to_u32_pairs(&fix.bit_map_long);

        // Decode biomes_int_b64 as i32 LE cells (the wire-side input).
        let biomes_int_bytes = B64.decode(&fix.biomes_int_b64).expect("biomes_int b64");
        assert_eq!(biomes_int_bytes.len() % 4, 0,
            "{}: biomes_int_b64 len not multiple of 4", fix.name);
        let mut biomes_cells = vec![0i32; biomes_int_bytes.len() / 4];
        for (i, c) in biomes_int_bytes.chunks_exact(4).enumerate() {
            biomes_cells[i] = i32::from_le_bytes([c[0], c[1], c[2], c[3]]);
        }

        let result = parse_chunk_sections_v16_v17(
            &chunk_data,
            &bit_map,
            fix.meta.num_sections,
            fix.meta.max_bits_per_block,
            Some(&biomes_cells),
            1,
        ).unwrap_or_else(|e| panic!("{}: parse failed: {}", fix.name, e));

        // Decode reference (Uint16Array little-endian bytes).
        let ref_bytes = B64.decode(&fix.reference.block_states_b64).expect("ref b64");
        let mut ref_blocks = vec![0u16; ref_bytes.len() / 2];
        for (i, c) in ref_bytes.chunks_exact(2).enumerate() {
            ref_blocks[i] = u16::from_le_bytes([c[0], c[1]]);
        }
        let ref_reordered = reorder_reference_to_section_layout(&ref_blocks, fix.meta.num_sections);

        assert_eq!(result.block_states.len(), ref_reordered.len(),
            "{}: block_states length mismatch", fix.name);

        if result.block_states != ref_reordered {
            let mut diffs = 0;
            for (i, (a, b)) in result.block_states.iter().zip(ref_reordered.iter()).enumerate() {
                if a != b {
                    if diffs < 10 {
                        eprintln!("  {}: diff[{}]: ours={} ref={}", fix.name, i, a, b);
                    }
                    diffs += 1;
                }
            }
            panic!("{}: block_states mismatch ({} diffs)", fix.name, diffs);
        }

        // Biomes parity: per-block reference vs parser output.
        let biomes_ref_bytes = B64.decode(&fix.reference.biomes_per_block_b64)
            .expect("biomesPerBlock b64");
        assert_eq!(biomes_ref_bytes.len(), fix.meta.num_sections * common::BLOCK_SECTION_VOLUME,
            "{}: biomesPerBlock length unexpected", fix.name);
        let biomes_ref_reordered = reorder_reference_u8_to_section_layout(
            &biomes_ref_bytes, fix.meta.num_sections);
        assert_eq!(result.biomes.len(), biomes_ref_reordered.len(),
            "{}: biomes length mismatch", fix.name);
        if result.biomes != biomes_ref_reordered {
            let mut diffs = 0;
            for (i, (a, b)) in result.biomes.iter().zip(biomes_ref_reordered.iter()).enumerate() {
                if a != b {
                    if diffs < 10 {
                        eprintln!("  {}: biome diff[{}]: ours={} ref={}", fix.name, i, a, b);
                    }
                    diffs += 1;
                }
            }
            panic!("{}: biomes mismatch ({} diffs)", fix.name, diffs);
        }
    }

    // ---- 1.16 parity ---------------------------------------------------
    //
    // The chunk_data wire format is byte-identical between 1.16 and 1.17, so
    // we reuse `parse_chunk_sections_v16_v17` unchanged. Only the fixture
    // shape differs: 1.16's `column.getMask()` returns a single number
    // (sectionMask bitfield) instead of a long-array, so we deserialize
    // `bitMap_int` and pack it into the `[lo, hi]` u32 pair the parser wants.

    #[derive(Deserialize)]
    struct FixtureV16 {
        name: String,
        meta: Meta,
        #[serde(rename = "chunkData_b64")] chunk_data_b64: String,
        #[serde(rename = "bitMap_int")] bit_map_int: i64,
        #[serde(rename = "biomes_int_b64")] biomes_int_b64: String,
        reference: Reference,
    }

    fn run_one_v16(path: &Path) {
        let bytes = fs::read(path).expect("fixture read");
        let fix: FixtureV16 = serde_json::from_slice(&bytes).expect("fixture parse");

        let chunk_data = B64.decode(&fix.chunk_data_b64).expect("chunk_data b64");
        // 1.16 sectionMask fits in 16 bits but we accept the full i64 the JSON
        // carries to be robust. Pack into the flat `[lo, hi]` u32 layout.
        let m = fix.bit_map_int as u64;
        let bit_map: Vec<u32> = vec![m as u32, (m >> 32) as u32];

        let biomes_int_bytes = B64.decode(&fix.biomes_int_b64).expect("biomes_int b64");
        assert_eq!(biomes_int_bytes.len() % 4, 0,
            "{}: biomes_int_b64 len not multiple of 4", fix.name);
        let mut biomes_cells = vec![0i32; biomes_int_bytes.len() / 4];
        for (i, c) in biomes_int_bytes.chunks_exact(4).enumerate() {
            biomes_cells[i] = i32::from_le_bytes([c[0], c[1], c[2], c[3]]);
        }

        let result = parse_chunk_sections_v16_v17(
            &chunk_data,
            &bit_map,
            fix.meta.num_sections,
            fix.meta.max_bits_per_block,
            Some(&biomes_cells),
            1,
        ).unwrap_or_else(|e| panic!("{}: parse failed: {}", fix.name, e));

        let ref_bytes = B64.decode(&fix.reference.block_states_b64).expect("ref b64");
        let mut ref_blocks = vec![0u16; ref_bytes.len() / 2];
        for (i, c) in ref_bytes.chunks_exact(2).enumerate() {
            ref_blocks[i] = u16::from_le_bytes([c[0], c[1]]);
        }
        let ref_reordered = reorder_reference_to_section_layout(&ref_blocks, fix.meta.num_sections);

        assert_eq!(result.block_states.len(), ref_reordered.len(),
            "{}: block_states length mismatch", fix.name);

        if result.block_states != ref_reordered {
            let mut diffs = 0;
            for (i, (a, b)) in result.block_states.iter().zip(ref_reordered.iter()).enumerate() {
                if a != b {
                    if diffs < 10 {
                        eprintln!("  {}: diff[{}]: ours={} ref={}", fix.name, i, a, b);
                    }
                    diffs += 1;
                }
            }
            panic!("{}: block_states mismatch ({} diffs)", fix.name, diffs);
        }

        let biomes_ref_bytes = B64.decode(&fix.reference.biomes_per_block_b64)
            .expect("biomesPerBlock b64");
        assert_eq!(biomes_ref_bytes.len(), fix.meta.num_sections * common::BLOCK_SECTION_VOLUME,
            "{}: biomesPerBlock length unexpected", fix.name);
        let biomes_ref_reordered = reorder_reference_u8_to_section_layout(
            &biomes_ref_bytes, fix.meta.num_sections);
        assert_eq!(result.biomes.len(), biomes_ref_reordered.len(),
            "{}: biomes length mismatch", fix.name);
        if result.biomes != biomes_ref_reordered {
            let mut diffs = 0;
            for (i, (a, b)) in result.biomes.iter().zip(biomes_ref_reordered.iter()).enumerate() {
                if a != b {
                    if diffs < 10 {
                        eprintln!("  {}: biome diff[{}]: ours={} ref={}", fix.name, i, a, b);
                    }
                    diffs += 1;
                }
            }
            panic!("{}: biomes mismatch ({} diffs)", fix.name, diffs);
        }
    }

    #[test]
    fn parity_all_v16_fixtures() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../chunk-packet-fixtures/fixtures-1.16");
        let entries = fs::read_dir(&dir)
            .unwrap_or_else(|_| panic!("no fixtures dir {:?}", dir));
        let mut count = 0;
        for e in entries.flatten() {
            let path = e.path();
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            if !name.ends_with(".json") || name.starts_with('_') { continue; }
            run_one_v16(&path);
            count += 1;
        }
        assert!(count >= 9, "expected at least 9 fixtures, got {}", count);
        eprintln!("[v16 parity] {} fixtures byte-perfect OK", count);
    }

    #[test]
    fn parity_all_v17_fixtures() {
        let dir = fixtures_dir();
        let entries = fs::read_dir(&dir)
            .unwrap_or_else(|_| panic!("no fixtures dir {:?}", dir));
        let mut count = 0;
        for e in entries.flatten() {
            let path = e.path();
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            if !name.ends_with(".json") || name.starts_with('_') { continue; }
            run_one(&path);
            count += 1;
        }
        assert!(count >= 9, "expected at least 9 fixtures, got {}", count);
        eprintln!("[v17 parity] {} fixtures byte-perfect OK", count);
    }

    /// Each cell ID is 1+cell_idx; verify every block in a 4×4×4 cube maps to
    /// the same id and that adjacent cubes get distinct ids — i.e. the 4×4×4
    /// → per-block expansion follows prismarine-chunk's `getBiome`.
    #[test]
    fn expand_biomes_v17_matches_4x4x4_cells() {
        let num_sections = NUM_SECTIONS_V17;
        let cells_count = num_sections * 64;
        let cells: Vec<i32> = (0..cells_count as i32).map(|i| i + 1).collect();

        let biomes = expand_biomes_v17(Some(&cells), num_sections, 0);
        assert_eq!(biomes.len(), num_sections * common::BLOCK_SECTION_VOLUME);

        for s in 0..num_sections {
            for y_in in 0..16usize {
                let y4 = (s * 16 + y_in) >> 2;
                for z in 0..16usize {
                    let z4 = z >> 2;
                    for x in 0..16usize {
                        let x4 = x >> 2;
                        let cell_idx = (y4 << 4) | (z4 << 2) | x4;
                        let expected = (cells[cell_idx] & 0xFF) as u8;
                        let actual = biomes[s * common::BLOCK_SECTION_VOLUME
                            | (y_in << 8) | (z << 4) | x];
                        assert_eq!(actual, expected,
                            "s={} y_in={} z={} x={} cell_idx={}", s, y_in, z, x, cell_idx);
                    }
                }
            }
        }
    }

    /// Without cells we fall back to `default_biome` for every block.
    #[test]
    fn expand_biomes_v17_default_when_none() {
        let biomes = expand_biomes_v17(None, NUM_SECTIONS_V17, 7);
        assert_eq!(biomes.len(), NUM_SECTIONS_V17 * common::BLOCK_SECTION_VOLUME);
        assert!(biomes.iter().all(|&v| v == 7));
    }

    /// Wrong-length cells: defensive fallback to default rather than panic.
    #[test]
    fn expand_biomes_v17_default_on_mismatch() {
        let too_short = vec![42i32; 10];
        let biomes = expand_biomes_v17(Some(&too_short), NUM_SECTIONS_V17, 5);
        assert!(biomes.iter().all(|&v| v == 5));
    }

    fn write_varint(out: &mut Vec<u8>, value: i32) {
        let mut u = value as u32;
        loop {
            let mut byte = (u & 0x7f) as u8;
            u >>= 7;
            if u != 0 {
                byte |= 0x80;
            }
            out.push(byte);
            if u == 0 {
                break;
            }
        }
    }

    fn write_i64_array(out: &mut Vec<u8>, values: &[i64]) {
        write_varint(out, values.len() as i32);
        for v in values {
            out.extend_from_slice(&v.to_be_bytes());
        }
    }

    fn write_light_arrays(out: &mut Vec<u8>, sections: &[Vec<u8>]) {
        write_varint(out, sections.len() as i32);
        for section in sections {
            write_varint(out, section.len() as i32);
            out.extend_from_slice(section);
        }
    }

    fn encode_update_light_v17(
        x: i32,
        z: i32,
        trust_edges: bool,
        sky_mask: &[i64],
        block_mask: &[i64],
        empty_sky_mask: &[i64],
        empty_block_mask: &[i64],
        sky_sections: &[Vec<u8>],
        block_sections: &[Vec<u8>],
    ) -> Vec<u8> {
        let mut out = Vec::new();
        write_varint(&mut out, 0x25);
        write_varint(&mut out, x);
        write_varint(&mut out, z);
        out.push(if trust_edges { 1 } else { 0 });
        write_i64_array(&mut out, sky_mask);
        write_i64_array(&mut out, block_mask);
        write_i64_array(&mut out, empty_sky_mask);
        write_i64_array(&mut out, empty_block_mask);
        write_light_arrays(&mut out, sky_sections);
        write_light_arrays(&mut out, block_sections);
        out
    }

    fn nibble_section(value: u8) -> Vec<u8> {
        vec![value | (value << 4); common::LIGHT_SECTION_BUFFER_BYTES]
    }

    #[test]
    fn update_light_omitted_sky_is_not_filled_with_15() {
        let packet = encode_update_light_v17(
            3,
            4,
            true,
            &[0b100],
            &[],
            &[],
            &[],
            &[nibble_section(3)],
            &[],
        );
        let result = parse_update_light_v17(&packet, NUM_SECTIONS_V17)
            .expect("parse synthetic update_light");
        let omitted = &result.sky_light[0..common::BLOCK_SECTION_VOLUME];
        assert!(
            !omitted.iter().all(|&v| v == 15),
            "omitted sky must not be baked as 15 in the parse result"
        );
        assert!(omitted.iter().all(|&v| v == 0), "omitted sky bytes stay 0, not a seed");
        assert_eq!(result.x, 3);
        assert_eq!(result.z, 4);
        assert!(result.trust_edges);
        assert!(!common::mask_bit_get(&result.sky_light_mask, 1), "world section 0 omitted");
        assert!(common::mask_bit_get(&result.sky_light_mask, 2), "world section 1 has data");
        let present = &result.sky_light[common::BLOCK_SECTION_VOLUME..common::BLOCK_SECTION_VOLUME * 2];
        assert!(present.iter().all(|&v| v == 3));
    }

    #[test]
    fn captured_1_17_1_update_light_fixture_parses() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../chunk-packet-fixtures/fixtures/map_chunk/1.17.1/5_0.update_light.bin");
        let packet = fs::read(&path).unwrap_or_else(|_| panic!("missing fixture {:?}", path));
        let result = parse_update_light_v17(&packet, NUM_SECTIONS_V17)
            .expect("parse captured 1.17.1 update_light");
        assert_eq!(result.x, 7);
        assert_eq!(result.z, 0);
        assert!(result.trust_edges);
        assert!(result.sky_light_mask.iter().all(|&w| w == 0));
        assert!(result.empty_sky_light_mask.iter().all(|&w| w == 0));
        assert!(result.block_light_mask.iter().all(|&w| w == 0));
        assert_eq!(result.empty_block_light_mask[0] & 0x3e, 0x3e);
        assert!(result.sky_light.iter().all(|&v| v == 0));
    }

    #[test]
    fn captured_1_17_1_second_fixture_parses() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../chunk-packet-fixtures/fixtures/map_chunk/1.17.1/7_0.update_light.bin");
        let packet = fs::read(&path).unwrap_or_else(|_| panic!("missing fixture {:?}", path));
        let result = parse_update_light_v17(&packet, NUM_SECTIONS_V17)
            .expect("parse captured 1.17.1 update_light");
        assert_eq!(result.x, 6);
        assert_eq!(result.z, 0);
        assert!(result.trust_edges);
        assert_eq!(result.empty_block_light_mask[0] & 0x3e, 0x3e);
    }

    #[test]
    fn update_light_keeps_padding_section() {
        let packet = encode_update_light_v17(
            0,
            0,
            false,
            &[0b1],
            &[],
            &[],
            &[],
            &[nibble_section(9)],
            &[],
        );
        let result = parse_update_light_v17(&packet, NUM_SECTIONS_V17).unwrap();
        assert!(common::mask_bit_get(&result.sky_light_mask, 0));
        let below = result.sky_below.expect("padding below");
        assert!(below.iter().all(|&v| v == 9));
        assert!(result.sky_light.iter().all(|&v| v == 0));
    }
}
