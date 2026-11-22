/** Packed 2048-byte nibble section ↔ unpacked 4096-byte per-block values. */

export const PACKED_LIGHT_SECTION_BYTES = 2048
export const UNPACKED_LIGHT_SECTION_BYTES = 4096

export function packUnpackedLightSection(unpacked: Uint8Array): Uint8Array {
  const packed = new Uint8Array(PACKED_LIGHT_SECTION_BYTES)
  const n = Math.min(unpacked.length, UNPACKED_LIGHT_SECTION_BYTES)
  for (let i = 0; i < n; i++) {
    const v = unpacked[i]! & 0x0f
    const byte = i >> 1
    packed[byte] = i & 1 ? (packed[byte]! & 0x0f) | (v << 4) : (packed[byte]! & 0xf0) | v
  }
  return packed
}

export function unpackPackedLightSection(packed: Uint8Array): Uint8Array {
  const unpacked = new Uint8Array(UNPACKED_LIGHT_SECTION_BYTES)
  const n = Math.min(packed.length, PACKED_LIGHT_SECTION_BYTES)
  for (let i = 0; i < n * 2 && i < UNPACKED_LIGHT_SECTION_BYTES; i++) {
    const byte = packed[i >> 1] ?? 0
    unpacked[i] = i & 1 ? byte >> 4 : byte & 0x0f
  }
  return unpacked
}
