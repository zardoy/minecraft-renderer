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
/// Returns `block_states` of length `num_sections * 4096`, laid out as
/// `idx = (s * 4096) + ((y_in << 8) | (z << 4) | x)` — i.e. per-section flat
/// stack, matching what the WASM mesher already consumes for 1.18+ blocks.
/// Sections whose bit is not set in `bit_map` are left as zeros (air).
///
/// Also returns `bytes_read` so callers can sanity-check they consumed the
/// whole `chunk_data` slice.
pub fn parse_chunk_sections_v17(
    chunk_data: &[u8],
    bit_map: &[u32],
    num_sections: usize,
    max_bits_per_block: u8,
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
        bytes_read: r.position(),
        bytes_total: chunk_data.len(),
    })
}

#[derive(Debug)]
pub struct ChunkSectionsResult {
    /// `num_sections * 4096`, layout `(s * 4096) | (y_in << 8) | (z << 4) | x`.
    pub block_states: Vec<u16>,
    #[allow(dead_code)]
    pub bytes_read: usize,
    #[allow(dead_code)]
    pub bytes_total: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    use serde::Deserialize;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn fixtures_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../dump-poc/fixtures-1.17")
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
    }

    #[derive(Deserialize)]
    struct Fixture {
        name: String,
        meta: Meta,
        #[serde(rename = "chunkData_b64")] chunk_data_b64: String,
        #[serde(rename = "bitMap_long")] bit_map_long: Vec<[u32; 2]>,
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

    fn run_one(path: &Path) {
        let bytes = fs::read(path).expect("fixture read");
        let fix: Fixture = serde_json::from_slice(&bytes).expect("fixture parse");

        let chunk_data = B64.decode(&fix.chunk_data_b64).expect("chunk_data b64");
        let bit_map = bit_map_to_u32_pairs(&fix.bit_map_long);

        let result = parse_chunk_sections_v17(
            &chunk_data,
            &bit_map,
            fix.meta.num_sections,
            fix.meta.max_bits_per_block,
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
}
