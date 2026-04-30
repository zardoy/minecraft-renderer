// Parser dlya Minecraft 1.18+ chunk-column dump-formata.
//
// Zerkalit JS-prototype iz dump-poc/parseDump-1.18.cjs i parseLight-1.18.cjs.
// Vhod — bynaryny buffer, kotoryi otdaёt prismarine-chunk column.dump() / column.dumpLight().
//
// Layout sekcii (block):
//   - solidBlockCount: int16 BE
//   - bitsPerBlock: u8
//   - bitsPerBlock == 0  → SingleValueContainer:
//       value: VarInt
//       size: u8 (= 0)
//   - bitsPerBlock <= 8  → IndirectPaletteContainer:
//       paletteLen: VarInt
//       palette[paletteLen]: VarInt[]
//       longCount: VarInt
//       data: longCount * 8 bytes (BitArrayNoSpan)
//   - bitsPerBlock > 8   → DirectPaletteContainer (global palette):
//       longCount: VarInt
//       data: longCount * 8 bytes (BitArrayNoSpan, bpv = max_bits_per_block)
//
// Layout sekcii (biome): identichno, no s drugimi konstantami:
//   maxBitsPerBiome (default 3 → indirect threshold), globalBitsPerBiome (default 6).

use std::io;

pub const BLOCK_SECTION_VOLUME: usize = 16 * 16 * 16; // 4096
pub const BIOME_SECTION_VOLUME: usize = 4 * 4 * 4;     // 64
pub const MAX_BITS_PER_BLOCK: u8 = 8;
pub const MAX_BITS_PER_BIOME: u8 = 3;
pub const LIGHT_SECTION_BUFFER_BYTES: usize = 2048;
pub const LIGHT_BPV: u8 = 4;

pub struct DumpReader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> DumpReader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }
    pub fn position(&self) -> usize { self.pos }
    pub fn remaining(&self) -> usize { self.buf.len() - self.pos }

    fn read_u8(&mut self) -> io::Result<u8> {
        if self.pos >= self.buf.len() {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "u8"));
        }
        let v = self.buf[self.pos];
        self.pos += 1;
        Ok(v)
    }
    fn read_i16_be(&mut self) -> io::Result<i16> {
        if self.pos + 2 > self.buf.len() {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "i16"));
        }
        let v = i16::from_be_bytes([self.buf[self.pos], self.buf[self.pos + 1]]);
        self.pos += 2;
        Ok(v)
    }
    fn read_u32_be(&mut self) -> io::Result<u32> {
        if self.pos + 4 > self.buf.len() {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "u32"));
        }
        let v = u32::from_be_bytes([
            self.buf[self.pos],
            self.buf[self.pos + 1],
            self.buf[self.pos + 2],
            self.buf[self.pos + 3],
        ]);
        self.pos += 4;
        Ok(v)
    }
    /// VarInt po wiki.vg: do 5 baytov, malenkii bit 7 — kontinuitet.
    /// Vozvrashchaet i32 (sovmestimo s prismarine-chunk varInt.read).
    fn read_varint(&mut self) -> io::Result<i32> {
        let mut result: u32 = 0;
        let mut num_read = 0;
        loop {
            let read = self.read_u8()?;
            let value = (read & 0x7f) as u32;
            result |= value << (7 * num_read);
            num_read += 1;
            if num_read > 5 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "varint too big"));
            }
            if read & 0x80 == 0 { break; }
        }
        Ok(result as i32)
    }
}

/// Schitaet `longs` longs (po 8 bayt = 2 u32 BE) v Vec<u32> dlya BitArray.
/// V data hranyatsya kak [low, high, low, high, ...].
fn read_bit_array_longs(reader: &mut DumpReader, longs: usize) -> io::Result<Vec<u32>> {
    let mut data = vec![0u32; longs * 2];
    let mut i = 0;
    while i < longs * 2 {
        // BitArray.writeBuffer pishet [data[i+1], data[i]] (high then low) BE.
        // Znachit pri chtenii: pervyi u32 → data[i+1] (high), vtoroi → data[i] (low).
        let high = reader.read_u32_be()?;
        let low = reader.read_u32_be()?;
        data[i + 1] = high;
        data[i] = low;
        i += 2;
    }
    Ok(data)
}

/// BitArray-NoSpan get: znacheniya ne peresekayut granicu long'a no mogut peresech 32-bit half.
#[inline]
pub fn bit_array_get(data: &[u32], bits_per_value: u8, values_per_long: usize, value_mask: u32, index: usize) -> u32 {
    let start_long_index = index / values_per_long;
    let index_in_long = (index - start_long_index * values_per_long) * bits_per_value as usize;
    if index_in_long >= 32 {
        let index_in_start_long = index_in_long - 32;
        let start_long = data[start_long_index * 2 + 1];
        return (start_long >> index_in_start_long) & value_mask;
    }
    let index_in_start_long = index_in_long;
    let start_long = data[start_long_index * 2];
    let mut result = start_long >> index_in_start_long;
    let end_bit_offset = index_in_start_long + bits_per_value as usize;
    if end_bit_offset > 32 {
        let end_long = data[start_long_index * 2 + 1];
        // shift > 31 in u32 — UB v Rust dlya << operatora; obrabotaem otdelno.
        let shift = 32 - index_in_start_long;
        if shift < 32 {
            result |= end_long << shift;
        }
    }
    result & value_mask
}

#[derive(Debug)]
pub enum Container {
    Single(u32),
    Indirect { palette: Vec<u32>, data: Vec<u32>, bits_per_value: u8 },
    Direct { data: Vec<u32>, bits_per_value: u8 },
}

impl Container {
    pub fn get(&self, index: usize) -> u32 {
        match self {
            Container::Single(v) => *v,
            Container::Indirect { palette, data, bits_per_value } => {
                let bpv = *bits_per_value;
                let vpl = (64 / bpv as usize).max(1);
                let mask = (1u32 << bpv) - 1;
                let pi = bit_array_get(data, bpv, vpl, mask, index) as usize;
                palette.get(pi).copied().unwrap_or(0)
            }
            Container::Direct { data, bits_per_value } => {
                let bpv = *bits_per_value;
                let vpl = (64 / bpv as usize).max(1);
                let mask = if bpv >= 32 { u32::MAX } else { (1u32 << bpv) - 1 };
                bit_array_get(data, bpv, vpl, mask, index)
            }
        }
    }
}

fn parse_container(reader: &mut DumpReader, max_bits_local: u8, global_bits: u8) -> io::Result<Container> {
    let bits_per_value = reader.read_u8()?;
    if bits_per_value == 0 {
        let value = reader.read_varint()? as u32;
        let _size_prefix = reader.read_u8()?; // vsegda 0 dlya non-1.21.5+
        return Ok(Container::Single(value));
    }
    if bits_per_value > max_bits_local {
        let longs = reader.read_varint()? as usize;
        let data = read_bit_array_longs(reader, longs)?;
        return Ok(Container::Direct { data, bits_per_value: global_bits });
    }
    let palette_len = reader.read_varint()? as usize;
    let mut palette = Vec::with_capacity(palette_len);
    for _ in 0..palette_len {
        palette.push(reader.read_varint()? as u32);
    }
    let longs = reader.read_varint()? as usize;
    let data = read_bit_array_longs(reader, longs)?;
    Ok(Container::Indirect { palette, data, bits_per_value })
}

#[derive(Debug)]
pub struct ParseDumpResult {
    pub block_states: Vec<u16>,    // num_sections * 4096
    pub biomes: Vec<u8>,            // num_sections * 64
    pub bytes_read: usize,
}

pub fn parse_dump(buffer: &[u8], num_sections: usize, max_bits_per_block: u8, max_bits_per_biome: u8) -> io::Result<ParseDumpResult> {
    let mut reader = DumpReader::new(buffer);
    let mut block_states = vec![0u16; num_sections * BLOCK_SECTION_VOLUME];
    let mut biomes = vec![0u8; num_sections * BIOME_SECTION_VOLUME];

    for s in 0..num_sections {
        let _solid_count = reader.read_i16_be()?;
        let block_container = parse_container(&mut reader, MAX_BITS_PER_BLOCK, max_bits_per_block)?;
        for i in 0..BLOCK_SECTION_VOLUME {
            block_states[s * BLOCK_SECTION_VOLUME + i] = block_container.get(i) as u16;
        }
        let biome_container = parse_container(&mut reader, MAX_BITS_PER_BIOME, max_bits_per_biome)?;
        for i in 0..BIOME_SECTION_VOLUME {
            biomes[s * BIOME_SECTION_VOLUME + i] = biome_container.get(i) as u8;
        }
    }

    Ok(ParseDumpResult {
        block_states,
        biomes,
        bytes_read: reader.position(),
    })
}

/// Raspakovyvaet odnu light-sekciyu (2048 bayt = BitArrayNoSpan bpv=4 capacity=4096).
pub fn unpack_light_section(buffer: &[u8]) -> io::Result<Vec<u8>> {
    if buffer.len() != LIGHT_SECTION_BUFFER_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!(
            "light buffer size {} != {}", buffer.len(), LIGHT_SECTION_BUFFER_BYTES
        )));
    }
    // 2048 bayt = 512 u32. Layout sovpadaet s blok-BitArray writeBuffer.
    let mut data = vec![0u32; 512];
    let mut reader = DumpReader::new(buffer);
    let mut i = 0;
    while i < 512 {
        let high = reader.read_u32_be()?;
        let low = reader.read_u32_be()?;
        data[i + 1] = high;
        data[i] = low;
        i += 2;
    }
    let mut out = vec![0u8; BLOCK_SECTION_VOLUME];
    for j in 0..BLOCK_SECTION_VOLUME {
        out[j] = bit_array_get(&data, LIGHT_BPV, 16, 0x0f, j) as u8;
    }
    Ok(out)
}

/// Razvorachivaet long-array maski v Vec<u8> bitov (po 1 bitu na element).
/// long_arr: kazhdyi element [high, low] (kak v dumpLight().skyLightMask).
pub fn mask_to_bits(long_arr: &[[i32; 2]], capacity: usize) -> Vec<u8> {
    let mut out = vec![0u8; capacity];
    for (i, lp) in long_arr.iter().enumerate() {
        let high = lp[0] as u32;
        let low = lp[1] as u32;
        for b in 0..32 {
            let idx = i * 64 + b;
            if idx < capacity { out[idx] = ((low >> b) & 1) as u8; }
        }
        for b in 0..32 {
            let idx = i * 64 + 32 + b;
            if idx < capacity { out[idx] = ((high >> b) & 1) as u8; }
        }
    }
    out
}

/// Polnyi parse light-dannyh. Vozvrashchaet (skylight, blocklight) razmera num_sections * 4096.
/// `light_buffers` — uzhe raspakovannye (raw) buffers iz dumpLight().skyLight / blockLight,
/// po poryadku ustanovlennyh bitov maski. Maska imeet capacity num_sections+2 (i=0 below world,
/// i=num_sections+1 above world — eti propuskayem).
pub fn parse_light_field(
    light_buffers: &[Vec<u8>],
    long_mask: &[[i32; 2]],
    num_sections: usize,
) -> io::Result<Vec<u8>> {
    let mask_capacity = num_sections + 2;
    let bits = mask_to_bits(long_mask, mask_capacity);
    let mut out = vec![0u8; num_sections * BLOCK_SECTION_VOLUME];
    let mut buf_idx = 0;
    for i in 0..mask_capacity {
        if bits[i] == 0 { continue; }
        let real_section_idx = i as i32 - 1;
        if buf_idx >= light_buffers.len() {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "mask says more sections than buffers"));
        }
        let buf = &light_buffers[buf_idx];
        buf_idx += 1;
        if real_section_idx < 0 || real_section_idx as usize >= num_sections {
            continue;
        }
        let unpacked = unpack_light_section(buf)?;
        let off = real_section_idx as usize * BLOCK_SECTION_VOLUME;
        out[off..off + BLOCK_SECTION_VOLUME].copy_from_slice(&unpacked);
    }
    if buf_idx != light_buffers.len() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "mask says fewer sections than buffers"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::fs;
    use std::path::{Path, PathBuf};
    use base64::{Engine as _, engine::general_purpose::STANDARD as B64};

    fn fixtures_dir() -> PathBuf {
        // wasm-mesher/Cargo.toml cwd = wasm-mesher/. fixtures v ../dump-poc/fixtures/
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

    /// Pereraskladyvaet reference (poryadok generator: y, z, x ot minY) v section-layout parsera.
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
