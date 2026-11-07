// Parser for the Minecraft 1.18+ `map_chunk` (a.k.a. `packet_chunk_data`) wire packet.
//
// Replaces the existing JS pipeline (mineflayer parses pkt → prismarine-chunk Column
// → JS `convertChunkToWasm` flattens to typed arrays) with one Rust pass that goes
// straight from the raw payload to the flat `block_states / biomes / sky_light /
// block_light` arrays the WASM mesher already consumes.
//
// Wire layout (1.18 → 1.21+, see minecraft-data play.toClient.types.packet_map_chunk):
//   - x: i32 BE
//   - z: i32 BE
//   - heightmaps: nbt (or anonymousNbt for 1.21.5+) → SKIP
//   - chunkData: VarInt size + bytes[size]
//   - blockEntities: VarInt count + array of (packedXZ:u8, y:i16, type:VarInt, data:nbt)
//   - trustEdges: bool   ← only 1.18 / 1.19, removed in 1.20
//   - skyLightMask:        VarInt count + i64[]
//   - blockLightMask:      VarInt count + i64[]
//   - emptySkyLightMask:   VarInt count + i64[]
//   - emptyBlockLightMask: VarInt count + i64[]
//   - skyLight:   VarInt count + array of (VarInt size + bytes[size]) — one per set bit
//   - blockLight: VarInt count + array of (VarInt size + bytes[size]) — one per set bit
//
// chunkData (per section, repeated num_sections times):
//   - solidBlockCount: i16 BE
//   - blocksContainer: PaletteContainer (max 8 bits before going Direct)
//   - biomesContainer: PaletteContainer (max 3 bits before going Direct)
//
// Output layout matches what `convertChunkToWasm` builds (the contract the WASM
// mesher already consumes):
//   index = x + z*16 + y_abs*256
//   y_abs in [0, num_sections * 16)
// Biomes are expanded from per-section 4×4×4 (64 values) to per-block (4096 values)
// the same way prismarine-chunk's `getBiome` does it: biome[y_abs][z][x] =
// container[(y_abs%16>>2)<<4 | (z>>2)<<2 | (x>>2)].

use std::io;

use crate::chunk_parser_common as common;

#[derive(Debug, Clone, Copy)]
pub struct McVersionFlags {
    /// true for 1.18 and 1.19 (protocol 757..=762). Removed in 1.20 (763+).
    pub has_trust_edges: bool,
    /// true for 1.21.5+ (protocol 770+). Heightmaps NBT root has no name.
    pub anonymous_heightmaps: bool,
    /// true for 1.21.5+: chunkBlockEntity uses anonymousNbt for its `data` field.
    pub anonymous_block_entity_nbt: bool,
    /// true for 1.21.5+ (protocol 770+). Heightmaps are an array of
    /// { type: VarInt, data: VarInt-counted i64[] } instead of NBT.
    pub heightmaps_as_arrays: bool,
    /// true for 1.21.5+ (protocol 770+). Palette containers carry no data array length.
    pub unprefixed_containers: bool,
    /// true for 26.1+ (protocol 775+). Each section has a fluid count after its block count.
    pub has_fluid_count: bool,
    /// true for 26.3+ (protocol 777+). The four light masks are byte arrays, not long arrays.
    pub byte_array_light_masks: bool,
}

impl McVersionFlags {
    /// Pick the right flags for a wire protocol version. Covers the range we
    /// currently care about (757..). Caller should validate beforehand that the
    /// protocol is actually a 1.18+ one — older versions need a different parser.
    pub fn for_protocol(protocol: i32) -> Self {
        Self {
            has_trust_edges: (757..=762).contains(&protocol), // 1.18.x and 1.19.x
            anonymous_heightmaps: protocol >= 764,             // 1.20.2+
            anonymous_block_entity_nbt: protocol >= 764,        // 1.20.2+
            heightmaps_as_arrays: protocol >= 770,              // 1.21.5+
            unprefixed_containers: protocol >= 770,             // 1.21.5+
            has_fluid_count: protocol >= 775,                   // 26.1+
            byte_array_light_masks: protocol >= 777,            // 26.3+
        }
    }
}

#[derive(Debug)]
pub struct MapChunkResult {
    pub x: i32,
    pub z: i32,
    /// num_sections * 4096, layout `x + z*16 + y_abs*256`.
    pub block_states: Vec<u16>,
    /// Same size, biome per block (expanded from 4×4×4 per-section palette).
    pub biomes: Vec<u8>,
    /// Same size. Defaults to 0 for missing sections (no skylight = pitch black).
    pub block_light: Vec<u8>,
    /// Same size. Defaults to 15 for missing sections (matches prismarine-chunk's
    /// `getSkyLight` default — exposed sections fill in real values, missing means
    /// "open sky").
    pub sky_light: Vec<u8>,
    /// Total bytes consumed from the input packet (including padding etc).
    pub bytes_read: usize,
}

/// `max_bits_per_block` and `max_bits_per_biome` are the global palette bits,
/// ceillog2 of the block state and biome registry sizes; direct containers are
/// stored with them.
pub fn parse_map_chunk_v18plus(
    packet: &[u8],
    num_sections: usize,
    max_bits_per_block: u8,
    max_bits_per_biome: u8,
    flags: McVersionFlags,
) -> io::Result<MapChunkResult> {
    let mut r = common::PacketReader::new(packet);

    // Raw `packet` from `client.on('raw.map_chunk', ...)` includes the leading
    // packet ID varint. Skip it — we already know what packet this is.
    let _packet_id = r.read_varint()?;

    let x = r.read_i32_be()?;
    let z = r.read_i32_be()?;

    if flags.heightmaps_as_arrays {
        let heightmaps = r.read_varint()?;
        for _ in 0..heightmaps {
            let _type = r.read_varint()?;
            common::read_i64_array(&mut r)?;
        }
    } else if flags.anonymous_heightmaps {
        common::skip_anonymous_nbt(&mut r)?;
    } else {
        common::skip_nbt(&mut r)?;
    }

    // chunkData = VarInt size + bytes[size]. Parse sections from a slice so we don't
    // have to special-case "did we consume exactly `size` bytes?" (the server is
    // free to pad in theory, though in practice it doesn't).
    let chunk_data_size = r.read_varint()? as usize;
    let chunk_data = r.read_bytes(chunk_data_size)?;

    let (block_states, biomes) = parse_chunk_sections(
        chunk_data,
        num_sections,
        max_bits_per_block,
        max_bits_per_biome,
        flags,
    )?;

    // blockEntities: VarInt count + array of {packedXZ:u8, y:i16, type:VarInt, data:nbt}
    let be_count = r.read_varint()? as usize;
    for _ in 0..be_count {
        let _packed = r.read_u8()?;
        let _y = r.read_i16_be()?;
        let _type = r.read_varint()?;
        if flags.anonymous_block_entity_nbt {
            common::skip_anonymous_nbt(&mut r)?;
        } else {
            common::skip_nbt(&mut r)?;
        }
    }

    if flags.has_trust_edges {
        let _trust_edges = r.read_u8()?;
    }

    let read_light_mask = if flags.byte_array_light_masks {
        common::read_byte_array_bitset
    } else {
        common::read_i64_array
    };
    let sky_light_mask = read_light_mask(&mut r)?;
    let block_light_mask = read_light_mask(&mut r)?;
    let empty_sky_light_mask = read_light_mask(&mut r)?;
    let empty_block_light_mask = read_light_mask(&mut r)?;

    let sky_light = common::read_light_arrays(&mut r)?;
    let block_light = common::read_light_arrays(&mut r)?;

    let bytes_read = r.position();

    // The light sections are vanilla DataLayer byte arrays: byte i holds blocks
    // 2i (low nibble) and 2i + 1 (high nibble), so they are not long encoded.
    let sky_full = common::build_full_column_light(
        &sky_light,
        &sky_light_mask,
        &empty_sky_light_mask,
        num_sections,
        0, // sections the server omitted entirely stay 0 (matches prismarine-chunk loadParsedLight)
        false,
    )?;
    let block_full = common::build_full_column_light(
        &block_light,
        &block_light_mask,
        &empty_block_light_mask,
        num_sections,
        0, // no skylight = no light
        false,
    )?;

    Ok(MapChunkResult {
        x,
        z,
        block_states,
        biomes,
        block_light: block_full,
        sky_light: sky_full,
        bytes_read,
    })
}

fn parse_chunk_sections(
    chunk_data: &[u8],
    num_sections: usize,
    max_bits_per_block: u8,
    max_bits_per_biome: u8,
    flags: McVersionFlags,
) -> io::Result<(Vec<u16>, Vec<u8>)> {
    let mut r = common::PacketReader::new(chunk_data);
    let block_layout = common::WireContainer::blocks(max_bits_per_block, flags.unprefixed_containers);
    let biome_layout = common::WireContainer::biomes(max_bits_per_biome, flags.unprefixed_containers);
    let total = num_sections * common::BLOCK_SECTION_VOLUME;
    let mut block_states = vec![0u16; total];
    let mut biomes = vec![0u8; total];

    for s in 0..num_sections {
        let _solid_count = r.read_i16_be()?;
        if flags.has_fluid_count {
            let _fluid_count = r.read_i16_be()?;
        }
        let blocks = common::parse_wire_container(&mut r, block_layout)?;
        let base_y_blocks = s * 16 * 256;
        for y_in in 0..16usize {
            let row_y = base_y_blocks + y_in * 256;
            let src_y = y_in << 8;
            for z in 0..16usize {
                let row_yz = row_y + z * 16;
                let src_yz = src_y | (z << 4);
                for x in 0..16usize {
                    block_states[row_yz + x] = blocks.get(src_yz | x) as u16;
                }
            }
        }

        let bio = common::parse_wire_container(&mut r, biome_layout)?;
        for y_in in 0..16usize {
            let y4 = y_in >> 2;
            let row_y = base_y_blocks + y_in * 256;
            for z in 0..16usize {
                let z4 = z >> 2;
                let row_yz = row_y + z * 16;
                for x in 0..16usize {
                    let x4 = x >> 2;
                    let bidx = (y4 << 4) | (z4 << 2) | x4;
                    biomes[row_yz + x] = bio.get(bidx) as u8;
                }
            }
        }
    }
    Ok((block_states, biomes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    /// A 1.21 (protocol 767) map_chunk with one all-air section and one sky light
    /// section whose first byte is `first_light_byte` and eighth byte `eighth_light_byte`.
    fn one_section_map_chunk(first_light_byte: u8, eighth_light_byte: u8) -> Vec<u8> {
        let mut p = vec![0x27]; // packet id
        p.extend_from_slice(&0i32.to_be_bytes()); // x
        p.extend_from_slice(&0i32.to_be_bytes()); // z
        p.extend_from_slice(&[0x0a, 0x00]); // heightmaps: empty anonymous compound
        let section = [0, 0, /* blocks */ 0, 0, 0, /* biomes */ 0, 0, 0];
        p.push(section.len() as u8);
        p.extend_from_slice(&section);
        p.push(0); // block entities
        p.push(1); // sky light mask: bit 1 = the first section
        p.extend_from_slice(&2i64.to_be_bytes());
        p.extend_from_slice(&[0, 0, 0]); // block light mask, empty sky and block light masks
        p.extend_from_slice(&[1, 0x80, 0x10]); // one sky light array of 2048 bytes
        let mut light = vec![0u8; 2048];
        light[0] = first_light_byte;
        light[7] = eighth_light_byte;
        p.extend_from_slice(&light);
        p.push(0); // block light arrays
        p
    }

    #[test]
    fn light_is_read_in_vanilla_nibble_order() {
        let packet = one_section_map_chunk(0x21, 0x43);
        let result = parse_map_chunk_v18plus(&packet, 1, 8, 3, McVersionFlags::for_protocol(767)).unwrap();
        assert_eq!(result.bytes_read, packet.len());
        // byte 0 holds x = 0 (low nibble) and x = 1, byte 7 holds x = 14 and x = 15
        assert_eq!(&result.sky_light[0..2], &[1, 2]);
        assert_eq!(&result.sky_light[14..16], &[3, 4]);
    }

    fn fixtures_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../chunk-packet-fixtures/fixtures/map_chunk")
    }

    /// Per-version smoke test: every fixture parses without error, consumes the
    /// entire packet, produces sensibly-sized arrays. Byte-for-byte parity with
    /// mineflayer's parser is checked separately once cross-validation reference
    /// JSON files are generated (next sub-step).
    fn smoke_for_version(
        version_dir: &str,
        protocol: i32,
        num_sections: usize,
    ) {
        let dir = fixtures_dir().join(version_dir);
        let entries = fs::read_dir(&dir)
            .unwrap_or_else(|_| panic!("no fixtures dir {:?}", dir));
        let flags = McVersionFlags::for_protocol(protocol);
        let mut count = 0;
        for e in entries.flatten() {
            let path = e.path();
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            if !name.ends_with(".map_chunk.bin") { continue; }
            let bytes = fs::read(&path).unwrap();
            let result = parse_map_chunk_v18plus(&bytes, num_sections, 8, 3, flags)
                .unwrap_or_else(|e| panic!("{}: parse failed: {}", name, e));

            assert_eq!(result.bytes_read, bytes.len(),
                "{}: bytes_read {} != packet size {}", name, result.bytes_read, bytes.len());
            assert_eq!(result.block_states.len(), num_sections * 4096, "{}: block_states size", name);
            assert_eq!(result.biomes.len(), num_sections * 4096, "{}: biomes size", name);
            assert_eq!(result.sky_light.len(), num_sections * 4096, "{}: sky_light size", name);
            assert_eq!(result.block_light.len(), num_sections * 4096, "{}: block_light size", name);
            count += 1;
        }
        assert!(count > 0, "no fixtures found in {:?}", dir);
        println!("[v18plus smoke] {}: {} fixtures OK", version_dir, count);
    }

    #[test] fn smoke_v118_2() { smoke_for_version("1.18.2", 758, 24); }
    #[test] fn smoke_v119_4() { smoke_for_version("1.19.4", 762, 24); }
    #[test] fn smoke_v120_4() { smoke_for_version("1.20.4", 765, 24); }
    #[test] fn smoke_v121()   { smoke_for_version("1.21",   767, 24); }
    #[test] fn smoke_v121_5() { smoke_for_version("1.21.5", 770, 24); }
    #[test] fn smoke_v121_11() { smoke_for_version("1.21.11", 774, 24); }
    #[test] fn smoke_v26_1()  { smoke_for_version("26.1",   775, 24); }
    #[test] fn smoke_v26_3()  { smoke_for_version("26.3",   777, 24); }

    // ---- Byte-perfect parity tests against mineflayer/prismarine-chunk reference ----

    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Reference {
        #[serde(rename = "numSections")] num_sections: usize,
        #[serde(rename = "minY")] _min_y: i32,
        block_states_b64: String,
        biomes_b64: String,
        sky_light_b64: String,
        block_light_b64: String,
    }

    fn parity_for_version(version_dir: &str, protocol: i32) {
        let dir = fixtures_dir().join(version_dir);
        let entries = fs::read_dir(&dir)
            .unwrap_or_else(|_| panic!("no fixtures dir {:?}", dir));
        let flags = McVersionFlags::for_protocol(protocol);
        let mut count = 0;
        for e in entries.flatten() {
            let path = e.path();
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            if !name.ends_with(".map_chunk.bin") { continue; }
            let stem = name.strip_suffix(".map_chunk.bin").unwrap();
            let ref_path = dir.join(format!("{}.reference.json", stem));
            if !ref_path.exists() {
                eprintln!("[parity {}] no reference for {}, skipping", version_dir, stem);
                continue;
            }
            let bytes = fs::read(&path).unwrap();
            let reference: Reference = serde_json::from_slice(&fs::read(&ref_path).unwrap()).unwrap();
            let num_sections = reference.num_sections;

            let result = parse_map_chunk_v18plus(&bytes, num_sections, 8, 3, flags)
                .unwrap_or_else(|err| panic!("{}: parse failed: {}", name, err));

            // block_states: Uint16 → 2 bytes per element, little-endian (Buffer.from(Uint16Array.buffer))
            let ref_blocks_bytes = B64.decode(&reference.block_states_b64).unwrap();
            let mut ref_blocks = vec![0u16; result.block_states.len()];
            for (i, c) in ref_blocks_bytes.chunks_exact(2).enumerate() {
                ref_blocks[i] = u16::from_le_bytes([c[0], c[1]]);
            }
            assert_eq!(result.block_states.len(), ref_blocks.len(), "{}: block_states len", name);
            if result.block_states != ref_blocks {
                eprintln!("--- {}: ours[256..272]: {:?}", name, &result.block_states[256..272]);
                eprintln!("--- {}: ref[256..272]:  {:?}", name, &ref_blocks[256..272]);
                let mut diffs = 0;
                for (i, (a, b)) in result.block_states.iter().zip(ref_blocks.iter()).enumerate() {
                    if a != b {
                        if diffs < 10 {
                            let y = i / 256;
                            let z = (i % 256) / 16;
                            let x = i % 16;
                            eprintln!("  diff[{}] (x={},z={},y_abs={}): ours={} ref={}", i, x, z, y, a, b);
                        }
                        diffs += 1;
                    }
                }
                panic!("{}: block_states mismatch ({} diffs out of {})", name, diffs, result.block_states.len());
            }

            let ref_biomes = B64.decode(&reference.biomes_b64).unwrap();
            assert_eq!(result.biomes, ref_biomes, "{}: biomes mismatch", name);

            let ref_sky = B64.decode(&reference.sky_light_b64).unwrap();
            assert_eq!(result.sky_light, ref_sky, "{}: sky_light mismatch", name);

            let ref_blk = B64.decode(&reference.block_light_b64).unwrap();
            assert_eq!(result.block_light, ref_blk, "{}: block_light mismatch", name);

            count += 1;
        }
        assert!(count > 0, "no reference fixtures found in {:?}", dir);
        println!("[v18plus parity] {}: {} fixtures byte-perfect OK", version_dir, count);
    }

    #[test] fn parity_v118_2() { parity_for_version("1.18.2", 758); }
    #[test] fn parity_v119_4() { parity_for_version("1.19.4", 762); }
    #[test] fn parity_v120_4() { parity_for_version("1.20.4", 765); }
    #[test] fn parity_v121()   { parity_for_version("1.21",   767); }
    // 1.21.5+: palette containers without a data array length
    #[test] fn parity_v121_5() { parity_for_version("1.21.5", 770); }
    #[test] fn parity_v121_11() { parity_for_version("1.21.11", 774); }
    // 26.1+: sections with a fluid count
    #[test] fn parity_v26_1()  { parity_for_version("26.1",   775); }
    // 26.3+: light masks as byte arrays
    #[test] fn parity_v26_3()  { parity_for_version("26.3",   777); }
}
