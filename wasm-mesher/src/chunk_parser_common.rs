// Common Minecraft chunk-packet parsing primitives.
//
// Shared between the legacy 1.18+ dump parser (`dump_parser.rs`) and future
// per-version `map_chunk` packet parsers (`parser_v18plus.rs`, `parser_v17.rs`, ...).
//
// What lives here:
//   - PacketReader: byte/u8/i16/u32/varint cursor over &[u8]
//   - Palette container model used since 1.13: Single / Indirect / Direct
//   - BitArray "no span" decoder (per-long values do NOT span 64-bit boundaries,
//     used by chunk sections since 1.16 and by light nibble arrays)
//   - Light helpers:
//       * unpack_light_section: 2048-byte nibble buffer -> 4096-element u8 array
//       * assemble_light_full_column: combine present/empty masks + concatenated
//         section buffers into a full-column light array (num_sections * 4096)
//       * parse_light_field / mask_to_bits: legacy helpers used by the dump-poc
//         path (kept here so the dump_parser only owns dump-specific code)
//
// What deliberately does NOT live here yet:
//   - VarLong reader (no current consumer)
//   - BitArray "spanning" decoder (1.13–1.15 chunk sections need this, will be
//     added when we port the 1.13–1.15 parser)
//   - NBT skipper (will be added with the 1.18+ packet parser, since map_chunk
//     contains heightmaps NBT we need to skip past)

use std::io;

pub const BLOCK_SECTION_VOLUME: usize = 16 * 16 * 16; // 4096 blocks per section
pub const BIOME_SECTION_VOLUME: usize = 4 * 4 * 4; //   64 biomes per section (4×4×4)
pub const MAX_BITS_PER_BLOCK: u8 = 8;
pub const MAX_BITS_PER_BIOME: u8 = 3;
pub const LIGHT_SECTION_BUFFER_BYTES: usize = 2048;
pub const LIGHT_BPV: u8 = 4;

// ─────────────────────────────────────────────────────────────────────────────
// PacketReader
// ─────────────────────────────────────────────────────────────────────────────

pub struct PacketReader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> PacketReader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }
    pub fn position(&self) -> usize { self.pos }
    pub fn remaining(&self) -> usize { self.buf.len() - self.pos }

    pub fn read_u8(&mut self) -> io::Result<u8> {
        if self.pos >= self.buf.len() {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "u8"));
        }
        let v = self.buf[self.pos];
        self.pos += 1;
        Ok(v)
    }

    pub fn read_i16_be(&mut self) -> io::Result<i16> {
        if self.pos + 2 > self.buf.len() {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "i16"));
        }
        let v = i16::from_be_bytes([self.buf[self.pos], self.buf[self.pos + 1]]);
        self.pos += 2;
        Ok(v)
    }

    pub fn read_u32_be(&mut self) -> io::Result<u32> {
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

    pub fn read_i32_be(&mut self) -> io::Result<i32> {
        Ok(self.read_u32_be()? as i32)
    }

    pub fn read_i64_be(&mut self) -> io::Result<i64> {
        if self.pos + 8 > self.buf.len() {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "i64"));
        }
        let mut b = [0u8; 8];
        b.copy_from_slice(&self.buf[self.pos..self.pos + 8]);
        self.pos += 8;
        Ok(i64::from_be_bytes(b))
    }

    pub fn read_u16_be(&mut self) -> io::Result<u16> {
        if self.pos + 2 > self.buf.len() {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "u16"));
        }
        let v = u16::from_be_bytes([self.buf[self.pos], self.buf[self.pos + 1]]);
        self.pos += 2;
        Ok(v)
    }

    pub fn read_f32_be(&mut self) -> io::Result<f32> {
        Ok(f32::from_bits(self.read_u32_be()?))
    }

    pub fn read_f64_be(&mut self) -> io::Result<f64> {
        Ok(f64::from_bits(self.read_i64_be()? as u64))
    }

    pub fn read_bytes(&mut self, n: usize) -> io::Result<&'a [u8]> {
        if self.pos + n > self.buf.len() {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "bytes"));
        }
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    pub fn skip(&mut self, n: usize) -> io::Result<()> {
        if self.pos + n > self.buf.len() {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "skip"));
        }
        self.pos += n;
        Ok(())
    }

    /// VarInt per wiki.vg: up to 5 bytes, low 7 bits payload, high bit = continuation.
    /// Returns i32 to match prismarine-protocol semantics.
    pub fn read_varint(&mut self) -> io::Result<i32> {
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

// ─────────────────────────────────────────────────────────────────────────────
// BitArray (no-span variant) — used by section palettes since 1.16 and by light
// ─────────────────────────────────────────────────────────────────────────────

/// Read `longs` 64-bit values into a Vec<u32> laid out as [low0, high0, low1, high1, ...].
/// The wire format is big-endian (high u32 first, then low u32) — matches BitArray's
/// writeBuffer in protodef.
pub fn read_bit_array_longs_no_span(reader: &mut PacketReader, longs: usize) -> io::Result<Vec<u32>> {
    let mut data = vec![0u32; longs * 2];
    let mut i = 0;
    while i < longs * 2 {
        let high = reader.read_u32_be()?;
        let low = reader.read_u32_be()?;
        data[i + 1] = high;
        data[i] = low;
        i += 2;
    }
    Ok(data)
}

/// BitArray-NoSpan get: values do not cross 64-bit boundaries but may cross the
/// internal 32-bit half within a long.
#[inline]
pub fn bit_array_no_span_get(
    data: &[u32],
    bits_per_value: u8,
    values_per_long: usize,
    value_mask: u32,
    index: usize,
) -> u32 {
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
        let shift = 32 - index_in_start_long;
        if shift < 32 {
            result |= end_long << shift;
        }
    }
    result & value_mask
}

// ─────────────────────────────────────────────────────────────────────────────
// Palette container (1.13+ section encoding)
// ─────────────────────────────────────────────────────────────────────────────

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
                let pi = bit_array_no_span_get(data, bpv, vpl, mask, index) as usize;
                palette.get(pi).copied().unwrap_or(0)
            }
            Container::Direct { data, bits_per_value } => {
                let bpv = *bits_per_value;
                let vpl = (64 / bpv as usize).max(1);
                let mask = if bpv >= 32 { u32::MAX } else { (1u32 << bpv) - 1 };
                bit_array_no_span_get(data, bpv, vpl, mask, index)
            }
        }
    }
}

/// Parse a single palette container.
///
/// Layout (1.18 dump and 1.18+ map_chunk section):
///   bits_per_value: u8
///   - 0  → Single: value (VarInt) + size (u8 = 0)
///   - ≤max_bits_local → Indirect: palette_len(VarInt) + palette[](VarInt) + longs(VarInt) + data
///   - >max_bits_local → Direct: longs(VarInt) + data, encoded with `global_bits` bpv
pub fn parse_container(
    reader: &mut PacketReader,
    max_bits_local: u8,
    global_bits: u8,
) -> io::Result<Container> {
    let bits_per_value = reader.read_u8()?;
    if bits_per_value == 0 {
        let value = reader.read_varint()? as u32;
        let _size_prefix = reader.read_u8()?; // always 0 for non-1.21.5+
        return Ok(Container::Single(value));
    }
    if bits_per_value > max_bits_local {
        let longs = reader.read_varint()? as usize;
        let data = read_bit_array_longs_no_span(reader, longs)?;
        return Ok(Container::Direct { data, bits_per_value: global_bits });
    }
    let palette_len = reader.read_varint()? as usize;
    let mut palette = Vec::with_capacity(palette_len);
    for _ in 0..palette_len {
        palette.push(reader.read_varint()? as u32);
    }
    let longs = reader.read_varint()? as usize;
    let data = read_bit_array_longs_no_span(reader, longs)?;
    Ok(Container::Indirect { palette, data, bits_per_value })
}

// ─────────────────────────────────────────────────────────────────────────────
// Light helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Test bit `i` of a "longs" mask laid out as [low0, high0, low1, high1, ...].
/// Matches the mineflayer/protodef BitSet representation after the per-long flip.
#[inline]
pub fn mask_bit_get(mask: &[u32], i: usize) -> bool {
    let long_idx = i >> 6;
    let bit_in_long = i & 63;
    let pair = long_idx * 2;
    if pair + 1 >= mask.len() { return false; }
    let val = if bit_in_long < 32 { mask[pair] } else { mask[pair + 1] };
    let bit = bit_in_long & 31;
    ((val >> bit) & 1) == 1
}

/// Assemble a full-column (`num_sections * 4096` bytes) light array from per-section
/// 2048-byte buffers, indexed by `mask`.
///
/// Light protocol detail: mask bit `i` corresponds to chunk section `i - 1` because
/// the network protocol includes one border section above the world AND one below.
/// So mask bit 1 = our section 0, ..., bit (num_sections) = section (num_sections - 1).
/// Border sections (bit 0 and bit num_sections+1) are present in the network packet
/// but irrelevant for in-world rendering.
///
/// `sections_concat` is the concatenation of all *present* light sections (each 2048
/// bytes), in mask-bit order. Empty sections (in `empty_mask`) are skipped in
/// `sections_concat` but their light values are 0.
///
/// Sections not present in `mask` AND not in `empty_mask` get `default_value` (e.g. 15
/// for skylight, matching prismarine-chunk's getSkyLight default).
pub fn assemble_light_full_column(
    sections_concat: &[u8],
    mask: &[u32],
    empty_mask: &[u32],
    num_sections: usize,
    default_value: u8,
) -> io::Result<Vec<u8>> {
    let total = num_sections * BLOCK_SECTION_VOLUME;
    let mut out = vec![default_value; total];
    let mut data_cursor = 0usize;

    let total_bits = num_sections + 2; // border below + sections + border above
    for mask_bit in 0..total_bits {
        let is_present = mask_bit_get(mask, mask_bit);
        let is_empty = mask_bit_get(empty_mask, mask_bit);
        if !is_present && !is_empty { continue; }

        let section_idx_in_chunk: i32 = mask_bit as i32 - 1;
        let in_chunk = section_idx_in_chunk >= 0 && (section_idx_in_chunk as usize) < num_sections;

        if is_empty {
            if in_chunk {
                let s = section_idx_in_chunk as usize;
                let base = s * 16 * 256;
                for y in 0..16 { for z in 0..16 { for x in 0..16 {
                    out[base + y * 256 + z * 16 + x] = 0;
                }}}
            }
            continue;
        }

        if data_cursor + LIGHT_SECTION_BUFFER_BYTES > sections_concat.len() {
            return Err(io::Error::new(io::ErrorKind::InvalidData,
                format!("light data underflow at mask_bit={} cursor={} len={}",
                    mask_bit, data_cursor, sections_concat.len())));
        }
        let section = &sections_concat[data_cursor..data_cursor + LIGHT_SECTION_BUFFER_BYTES];
        data_cursor += LIGHT_SECTION_BUFFER_BYTES;

        if !in_chunk { continue; }
        let s = section_idx_in_chunk as usize;
        let base = s * 16 * 256;
        for byte_idx in 0..LIGHT_SECTION_BUFFER_BYTES {
            let byte = section[byte_idx];
            let v0 = byte & 0x0F;
            let v1 = (byte >> 4) & 0x0F;
            let block0 = byte_idx * 2;
            let block1 = block0 + 1;
            for (block_local, value) in [(block0, v0), (block1, v1)] {
                let y_in = block_local >> 8;
                let z = (block_local >> 4) & 0xF;
                let x = block_local & 0xF;
                out[base + y_in * 256 + z * 16 + x] = value;
            }
        }
    }
    Ok(out)
}

/// Unpack a single light section (2048 bytes = BitArrayNoSpan bpv=4 capacity=4096).
pub fn unpack_light_section(buffer: &[u8]) -> io::Result<Vec<u8>> {
    if buffer.len() != LIGHT_SECTION_BUFFER_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!(
            "light buffer size {} != {}", buffer.len(), LIGHT_SECTION_BUFFER_BYTES
        )));
    }
    let mut data = vec![0u32; 512];
    let mut reader = PacketReader::new(buffer);
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
        out[j] = bit_array_no_span_get(&data, LIGHT_BPV, 16, 0x0f, j) as u8;
    }
    Ok(out)
}

/// Unfold a long-array mask into per-bit Vec<u8> (1 byte per bit).
/// `long_arr`: each element is [high, low] (matches dumpLight().skyLightMask format).
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

/// Full light parse helper used by the dump-poc path. Returns (skylight or blocklight)
/// of size num_sections * 4096.
///
/// `light_buffers` are the already-unpacked raw buffers from dumpLight().skyLight /
/// blockLight, in the order of the set bits in the mask. Mask capacity is
/// num_sections+2 (i=0 below world, i=num_sections+1 above world — both skipped).
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

// ─────────────────────────────────────────────────────────────────────────────
// NBT skipper
// ─────────────────────────────────────────────────────────────────────────────
//
// We never need NBT contents in the meshing pipeline (heightmaps and blockEntities
// are skipped), but we MUST advance the cursor past them. Implementing a full NBT
// reader in Rust is overkill — a structural skipper is enough.
//
// Two top-level shapes appear in the protocol:
//   - "nbt" (≤1.21.4): root tag id + (if not TAG_End) u16 BE name length + name + payload
//   - "anonymousNbt" (1.21.5+): root tag id + payload (no name)
//
// In practice the root is always TAG_Compound (id=10) for heightmaps, so the
// distinction only changes whether we read a name string for the root.

const TAG_END: u8 = 0;
const TAG_BYTE: u8 = 1;
const TAG_SHORT: u8 = 2;
const TAG_INT: u8 = 3;
const TAG_LONG: u8 = 4;
const TAG_FLOAT: u8 = 5;
const TAG_DOUBLE: u8 = 6;
const TAG_BYTE_ARRAY: u8 = 7;
const TAG_STRING: u8 = 8;
const TAG_LIST: u8 = 9;
const TAG_COMPOUND: u8 = 10;
const TAG_INT_ARRAY: u8 = 11;
const TAG_LONG_ARRAY: u8 = 12;

fn skip_nbt_string(reader: &mut PacketReader) -> io::Result<()> {
    let len = reader.read_u16_be()? as usize;
    reader.skip(len)
}

fn skip_nbt_payload(reader: &mut PacketReader, tag: u8) -> io::Result<()> {
    match tag {
        TAG_END => Ok(()),
        TAG_BYTE => reader.skip(1),
        TAG_SHORT => reader.skip(2),
        TAG_INT => reader.skip(4),
        TAG_LONG => reader.skip(8),
        TAG_FLOAT => reader.skip(4),
        TAG_DOUBLE => reader.skip(8),
        TAG_BYTE_ARRAY => {
            let n = reader.read_u32_be()? as usize;
            reader.skip(n)
        }
        TAG_STRING => skip_nbt_string(reader),
        TAG_LIST => {
            let item_tag = reader.read_u8()?;
            let n = reader.read_u32_be()? as i32;
            if n <= 0 { return Ok(()); }
            for _ in 0..n {
                skip_nbt_payload(reader, item_tag)?;
            }
            Ok(())
        }
        TAG_COMPOUND => {
            loop {
                let inner_tag = reader.read_u8()?;
                if inner_tag == TAG_END { break; }
                skip_nbt_string(reader)?;
                skip_nbt_payload(reader, inner_tag)?;
            }
            Ok(())
        }
        TAG_INT_ARRAY => {
            let n = reader.read_u32_be()? as usize;
            reader.skip(n * 4)
        }
        TAG_LONG_ARRAY => {
            let n = reader.read_u32_be()? as usize;
            reader.skip(n * 8)
        }
        other => Err(io::Error::new(io::ErrorKind::InvalidData,
            format!("unknown NBT tag {}", other))),
    }
}

/// Skip a `nbt` field (named root). Layout: tag_id (+ name + payload). TAG_End → 0 bytes after.
pub fn skip_nbt(reader: &mut PacketReader) -> io::Result<()> {
    let tag = reader.read_u8()?;
    if tag == TAG_END { return Ok(()); }
    skip_nbt_string(reader)?;
    skip_nbt_payload(reader, tag)
}

/// Skip an `anonymousNbt` field (1.21.5+, no root name). Layout: tag_id + payload.
pub fn skip_anonymous_nbt(reader: &mut PacketReader) -> io::Result<()> {
    let tag = reader.read_u8()?;
    if tag == TAG_END { return Ok(()); }
    skip_nbt_payload(reader, tag)
}

/// Convert an array of i64 (BitSet/light mask wire format) into the [low, high] u32
/// layout that `mask_bit_get` and `assemble_light_full_column` expect.
pub fn i64_mask_to_u32_pairs(mask: &[i64]) -> Vec<u32> {
    let mut out = Vec::with_capacity(mask.len() * 2);
    for v in mask {
        let u = *v as u64;
        out.push(u as u32);          // low
        out.push((u >> 32) as u32);  // high
    }
    out
}
