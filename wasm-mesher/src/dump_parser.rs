// Parser for Minecraft 1.18+ chunk-column dump format produced by the prismarine-chunk
// fork's `column.dump()` / `column.dumpLight()`. Keeps only dump-specific glue —
// shared primitives (palette container, BitArray, light helpers) live in
// `chunk_parser_common`.
//
// Per-section block layout in the dump:
//   - solidBlockCount: i16 BE
//   - palette container (block) — see chunk_parser_common::parse_container
//   - palette container (biome)
//
// Light: `column.dumpLight()` returns per-section 2048-byte buffers + bit masks;
// see chunk_parser_common::assemble_light_full_column / parse_light_field.

use std::io;

use crate::chunk_parser_common as common;
// Re-export anything that lib.rs already imports through `dump_parser::...` so we
// don't have to touch wasm-bindgen entry-points in this refactor.
pub use crate::chunk_parser_common::{
    assemble_light_full_column,
    mask_to_bits,
    parse_light_field,
    unpack_light_section,
    BLOCK_SECTION_VOLUME,
    BIOME_SECTION_VOLUME,
    LIGHT_SECTION_BUFFER_BYTES,
    LIGHT_BPV,
    MAX_BITS_PER_BLOCK,
    MAX_BITS_PER_BIOME,
};

#[derive(Debug)]
pub struct ParseDumpResult {
    pub block_states: Vec<u16>, // num_sections * 4096
    pub biomes: Vec<u8>,        // num_sections * 64
    pub bytes_read: usize,
}

pub fn parse_dump(
    buffer: &[u8],
    num_sections: usize,
    max_bits_per_block: u8,
    max_bits_per_biome: u8,
) -> io::Result<ParseDumpResult> {
    let mut reader = common::PacketReader::new(buffer);
    let mut block_states = vec![0u16; num_sections * common::BLOCK_SECTION_VOLUME];
    let mut biomes = vec![0u8; num_sections * common::BIOME_SECTION_VOLUME];

    for s in 0..num_sections {
        let _solid_count = reader.read_i16_be()?;
        let block_container = common::parse_container(&mut reader, common::MAX_BITS_PER_BLOCK, max_bits_per_block)?;
        for i in 0..common::BLOCK_SECTION_VOLUME {
            block_states[s * common::BLOCK_SECTION_VOLUME + i] = block_container.get(i) as u16;
        }
        let biome_container = common::parse_container(&mut reader, common::MAX_BITS_PER_BIOME, max_bits_per_biome)?;
        for i in 0..common::BIOME_SECTION_VOLUME {
            biomes[s * common::BIOME_SECTION_VOLUME + i] = biome_container.get(i) as u8;
        }
    }

    Ok(ParseDumpResult {
        block_states,
        biomes,
        bytes_read: reader.position(),
    })
}

/// PoC bench helper: parses dump WITHOUT materializing block_states/biomes Vecs.
/// Goal — isolate raw parse cost from the marshalling cost (Rust→JS Uint16Array copy
/// + JS object construction) measured by `parse_dump`. Returns a checksum so the
/// optimizer cannot eliminate the work.
pub fn parse_dump_checksum(
    buffer: &[u8],
    num_sections: usize,
    max_bits_per_block: u8,
    max_bits_per_biome: u8,
) -> io::Result<u64> {
    let mut reader = common::PacketReader::new(buffer);
    let mut checksum: u64 = 0;
    for _s in 0..num_sections {
        let _solid_count = reader.read_i16_be()?;
        let block_container = common::parse_container(&mut reader, common::MAX_BITS_PER_BLOCK, max_bits_per_block)?;
        for i in 0..common::BLOCK_SECTION_VOLUME {
            checksum = checksum.wrapping_add(block_container.get(i) as u64);
        }
        let biome_container = common::parse_container(&mut reader, common::MAX_BITS_PER_BIOME, max_bits_per_biome)?;
        for i in 0..common::BIOME_SECTION_VOLUME {
            checksum = checksum.wrapping_add(biome_container.get(i) as u64);
        }
    }
    Ok(checksum)
}

/// Parse dump into full-column layout that matches `convertChunkToWasm`:
///   blocks/biomes use index = x + z*16 + (y - 0)*256, where y goes 0..(num_sections*16).
///   Biomes are expanded from 4×4×4 (64 per section) to per-block (4096 per section)
///   the same way prismarine-chunk's `getBiome(pos)` does it: `(x>>2, y>>2, z>>2)`.
///
/// This is the input layout that the existing JS path (`convertChunkToWasm`) hands to
/// `generate_geometry`. Producing it directly from the dump buffer eliminates the
/// per-block JS getter loop AND the per-section reorder step.
pub struct FullColumnResult {
    pub block_states: Vec<u16>, // num_sections * 4096, layout x + z*16 + y*256
    pub biomes: Vec<u8>,        // same size, biome per block (expanded from 4x4x4)
    pub bytes_read: usize,
}

pub fn parse_dump_full_column(
    buffer: &[u8],
    num_sections: usize,
    max_bits_per_block: u8,
    max_bits_per_biome: u8,
) -> io::Result<FullColumnResult> {
    let mut reader = common::PacketReader::new(buffer);
    let total = num_sections * common::BLOCK_SECTION_VOLUME;
    let mut block_states = vec![0u16; total];
    let mut biomes = vec![0u8; total];

    for s in 0..num_sections {
        let _solid_count = reader.read_i16_be()?;
        let block_container = common::parse_container(&mut reader, common::MAX_BITS_PER_BLOCK, max_bits_per_block)?;
        // dump per-section index = (y_in_section << 8) | (z << 4) | x
        // full-column index = x + z*16 + y_abs*256, where y_abs = s*16 + y_in_section
        let base_y_blocks = s * 16 * 256;
        for y_in in 0..16usize {
            let row_y = base_y_blocks + y_in * 256;
            let src_y = y_in << 8;
            for z in 0..16usize {
                let row_yz = row_y + z * 16;
                let src_yz = src_y | (z << 4);
                for x in 0..16usize {
                    block_states[row_yz + x] = block_container.get(src_yz | x) as u16;
                }
            }
        }

        let biome_container = common::parse_container(&mut reader, common::MAX_BITS_PER_BIOME, max_bits_per_biome)?;
        // dump biomes: 4×4×4 per section, index = (y4 << 4) | (z4 << 2) | x4
        // expanded: each block (x,y_in,z) → biome at (x>>2, y_in>>2, z>>2)
        for y_in in 0..16usize {
            let y4 = y_in >> 2;
            let row_y = base_y_blocks + y_in * 256;
            for z in 0..16usize {
                let z4 = z >> 2;
                let row_yz = row_y + z * 16;
                for x in 0..16usize {
                    let x4 = x >> 2;
                    let bidx = (y4 << 4) | (z4 << 2) | x4;
                    biomes[row_yz + x] = biome_container.get(bidx) as u8;
                }
            }
        }
    }

    Ok(FullColumnResult {
        block_states,
        biomes,
        bytes_read: reader.position(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::fs;
    use std::path::{Path, PathBuf};
    use base64::{Engine as _, engine::general_purpose::STANDARD as B64};

    fn fixtures_dir() -> PathBuf {
        // wasm-mesher/Cargo.toml cwd = wasm-mesher/. fixtures in ../dump-poc/fixtures/
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../dump-poc/fixtures")
    }

    fn list_fixture_files() -> Vec<PathBuf> {
        let mut files: Vec<PathBuf> = fs::read_dir(fixtures_dir()).unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().map(|e| e == "json").unwrap_or(false))
            .filter(|p| !p.file_name().unwrap().to_str().unwrap().starts_with('_'))
            .collect();
        files.sort();
        files
    }

    fn b64_to_u16_le(s: &str) -> Vec<u16> {
        let bytes = B64.decode(s).unwrap();
        let mut out = vec![0u16; bytes.len() / 2];
        for i in 0..out.len() {
            out[i] = u16::from_le_bytes([bytes[i * 2], bytes[i * 2 + 1]]);
        }
        out
    }

    /// Reorders reference (generator order: y, z, x from minY) into the parser's section layout.
    fn reorder_blocks_to_section_layout(refs: &[u16], num_sections: usize) -> Vec<u16> {
        let mut out = vec![0u16; num_sections * 4096];
        for s in 0..num_sections {
            for y_in in 0..16 {
                let y_abs = s * 16 + y_in;
                for z in 0..16 {
                    for x in 0..16 {
                        let ref_idx = y_abs * 256 + z * 16 + x;
                        let dst_idx = s * 4096 + ((y_in << 8) | (z << 4) | x);
                        out[dst_idx] = refs[ref_idx];
                    }
                }
            }
        }
        out
    }

    fn reorder_u8_to_section_layout(refs: &[u8], num_sections: usize) -> Vec<u8> {
        let mut out = vec![0u8; num_sections * 4096];
        for s in 0..num_sections {
            for y_in in 0..16 {
                let y_abs = s * 16 + y_in;
                for z in 0..16 {
                    for x in 0..16 {
                        let ref_idx = y_abs * 256 + z * 16 + x;
                        let dst_idx = s * 4096 + ((y_in << 8) | (z << 4) | x);
                        out[dst_idx] = refs[ref_idx];
                    }
                }
            }
        }
        out
    }

    fn reorder_biomes(refs: &[u8], num_sections: usize) -> Vec<u8> {
        let mut out = vec![0u8; num_sections * 64];
        for s in 0..num_sections {
            for y_in4 in 0..4 {
                let y_abs4 = s * 4 + y_in4;
                for z4 in 0..4 {
                    for x4 in 0..4 {
                        let ref_idx = y_abs4 * 16 + z4 * 4 + x4;
                        let dst_idx = s * 64 + ((y_in4 << 4) | (z4 << 2) | x4);
                        out[dst_idx] = refs[ref_idx];
                    }
                }
            }
        }
        out
    }

    fn parse_long_mask(v: &Value) -> Vec<[i32; 2]> {
        v.as_array().unwrap().iter().map(|p| {
            let arr = p.as_array().unwrap();
            [arr[0].as_i64().unwrap() as i32, arr[1].as_i64().unwrap() as i32]
        }).collect()
    }

    #[test]
    fn all_fixtures_byte_perfect() {
        let files = list_fixture_files();
        assert!(!files.is_empty(), "no fixtures found in {:?}", fixtures_dir());

        let mut pass = 0usize;
        let mut fail = 0usize;
        let mut report: Vec<String> = vec![];

        for f in &files {
            let json: Value = serde_json::from_str(&fs::read_to_string(f).unwrap()).unwrap();
            let name = json["name"].as_str().unwrap().to_string();
            let meta = &json["meta"];
            let num_sections = meta["numSections"].as_u64().unwrap() as usize;
            let max_bpb = meta["maxBitsPerBlock"].as_u64().unwrap() as u8;
            let max_bpbi = meta["maxBitsPerBiome"].as_u64().unwrap() as u8;

            let dump = B64.decode(json["dump_b64"].as_str().unwrap()).unwrap();

            let result = parse_dump(&dump, num_sections, max_bpb, max_bpbi).unwrap();

            // Reference
            let ref_blocks = b64_to_u16_le(json["reference"]["blockStates_b64"].as_str().unwrap());
            let ref_block_light = B64.decode(json["reference"]["blockLight_b64"].as_str().unwrap()).unwrap();
            let ref_sky_light = B64.decode(json["reference"]["skyLight_b64"].as_str().unwrap()).unwrap();
            let ref_biomes = B64.decode(json["reference"]["biomes_b64"].as_str().unwrap()).unwrap();

            let exp_blocks = reorder_blocks_to_section_layout(&ref_blocks, num_sections);
            let exp_block_light = reorder_u8_to_section_layout(&ref_block_light, num_sections);
            let exp_sky_light = reorder_u8_to_section_layout(&ref_sky_light, num_sections);
            let exp_biomes = reorder_biomes(&ref_biomes, num_sections);

            // Light
            let light = &json["light"];
            let sky_buffers: Vec<Vec<u8>> = light["skyLight_b64"].as_array().unwrap().iter()
                .map(|s| B64.decode(s.as_str().unwrap()).unwrap()).collect();
            let block_buffers: Vec<Vec<u8>> = light["blockLight_b64"].as_array().unwrap().iter()
                .map(|s| B64.decode(s.as_str().unwrap()).unwrap()).collect();
            let sky_mask = parse_long_mask(&light["skyLightMask"]);
            let block_mask = parse_long_mask(&light["blockLightMask"]);

            let parsed_sky = parse_light_field(&sky_buffers, &sky_mask, num_sections).unwrap();
            let parsed_block = parse_light_field(&block_buffers, &block_mask, num_sections).unwrap();

            let bytes_ok = result.bytes_read == dump.len();
            let blocks_ok = result.block_states == exp_blocks;
            let biomes_ok = result.biomes == exp_biomes;
            let bl_ok = parsed_block == exp_block_light;
            let sl_ok = parsed_sky == exp_sky_light;
            let all_ok = bytes_ok && blocks_ok && biomes_ok && bl_ok && sl_ok;

            let status = if all_ok { "PASS" } else { "FAIL" };
            if all_ok { pass += 1; } else { fail += 1; }

            report.push(format!(
                "[{}] {:32} bytes={}/{} blocks={} biomes={} blockLight={} skyLight={}",
                status, name, result.bytes_read, dump.len(),
                if blocks_ok { "✓" } else { "✗" },
                if biomes_ok { "✓" } else { "✗" },
                if bl_ok { "✓" } else { "✗" },
                if sl_ok { "✓" } else { "✗" },
            ));
        }

        for line in &report { println!("{}", line); }
        println!("\n{}/{} fixtures passed.", pass, pass + fail);
        assert_eq!(fail, 0, "Some fixtures failed");
    }
}
