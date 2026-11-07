import { describe, expect, it } from 'vitest'
import {
  GlobalLegacyBufferGPU,
  VERTS_PER_QUAD,
  DRAW_VERTS_PER_QUAD,
  FLOATS_PER_POS,
  FLOATS_PER_UV,
  FLOATS_PER_COLOR,
  SECTION_INDEX_SHIFT,
  type LegacySectionGeometry
} from '../globalLegacyBufferGPU'
import { SECTION_META_STRIDE } from '../globalBlockBufferGPU'

/** Standard two-triangle quad winding, matching the WebGL quadIndexTemplate. */
const QUAD_TEMPLATE = [0, 1, 2, 2, 1, 3]

function geometry(quadCount: number, seed = 1): LegacySectionGeometry {
  const verts = quadCount * VERTS_PER_QUAD
  const positions = new Float32Array(verts * FLOATS_PER_POS)
  const colors = new Float32Array(verts * FLOATS_PER_COLOR)
  const uvs = new Float32Array(verts * FLOATS_PER_UV)
  const skyLights = new Float32Array(verts)
  const blockLights = new Float32Array(verts)
  const indices = new Uint32Array(quadCount * DRAW_VERTS_PER_QUAD)

  for (let v = 0; v < verts; v++) {
    positions[v * FLOATS_PER_POS] = seed * 100 + v
    colors[v * FLOATS_PER_COLOR] = v / 255
    uvs[v * FLOATS_PER_UV] = v / 16
    skyLights[v] = 15
    blockLights[v] = 0
  }
  for (let q = 0; q < quadCount; q++) {
    for (const [i, corner] of QUAD_TEMPLATE.entries()) {
      indices[q * DRAW_VERTS_PER_QUAD + i] = q * VERTS_PER_QUAD + corner
    }
  }
  return { positions, colors, uvs, skyLights, blockLights, indices }
}

const quadMetaOf = (b: GlobalLegacyBufferGPU) => b.quadMeta.array as Uint32Array
const metaOf = (b: GlobalLegacyBufferGPU) => b.sectionMeta.array as Int32Array

/** Mirrors the unpack the TSL vertex shader performs. */
function unpackCorners(packed: number): number[] {
  return Array.from({ length: DRAW_VERTS_PER_QUAD }, (_, i) => (packed >>> (i * 2)) & 0x3)
}
const unpackSectionIndex = (packed: number) => (packed >>> SECTION_INDEX_SHIFT) & 0xf_ff_ff

describe('GlobalLegacyBufferGPU', () => {
  it('packs the corner template so the shader can recover it', () => {
    const buffer = new GlobalLegacyBufferGPU({ initialCapacityQuads: 64 })
    buffer.addSection('a', geometry(1), 0, 0, 0)

    expect(unpackCorners(quadMetaOf(buffer)[1])).toEqual(QUAD_TEMPLATE)
  })

  it('packs a flipped-diagonal template independently per quad', () => {
    const flipped = [0, 3, 2, 0, 1, 3]
    const geo = geometry(2)
    for (const [i, corner] of flipped.entries()) {
      geo.indices[DRAW_VERTS_PER_QUAD + i] = VERTS_PER_QUAD + corner
    }

    const buffer = new GlobalLegacyBufferGPU({ initialCapacityQuads: 64 })
    buffer.addSection('a', geo, 0, 0, 0)

    expect(unpackCorners(quadMetaOf(buffer)[1])).toEqual(QUAD_TEMPLATE)
    expect(unpackCorners(quadMetaOf(buffer)[3])).toEqual(flipped)
  })

  it('packs the section index alongside the template without collision', () => {
    const buffer = new GlobalLegacyBufferGPU({ initialCapacityQuads: 256 })
    buffer.addSection('a', geometry(1), 0, 0, 0)
    buffer.addSection('b', geometry(1), 1, 0, 0)

    const packedA = quadMetaOf(buffer)[1]
    const packedB = quadMetaOf(buffer)[3]

    // Templates identical, section indices distinct — proves the fields don't overlap.
    expect(unpackCorners(packedA)).toEqual(unpackCorners(packedB))
    expect(unpackSectionIndex(packedA)).toBe(0)
    expect(unpackSectionIndex(packedB)).toBe(1)
  })

  it('resolves the section origin the shader will read via the packed index', () => {
    const buffer = new GlobalLegacyBufferGPU({ initialCapacityQuads: 64 })
    buffer.addSection('a', geometry(1), -7, 2, 19)

    const sectionIndex = unpackSectionIndex(quadMetaOf(buffer)[1])
    const meta = metaOf(buffer)
    const base = sectionIndex * SECTION_META_STRIDE
    expect([meta[base], meta[base + 1], meta[base + 2]]).toEqual([-7, 2, 19])
  })

  it('points each quad at its own vertex base', () => {
    const buffer = new GlobalLegacyBufferGPU({ initialCapacityQuads: 64 })
    buffer.addSection('a', geometry(3), 0, 0, 0)

    const meta = quadMetaOf(buffer)
    expect([meta[0], meta[2], meta[4]]).toEqual([0, VERTS_PER_QUAD, VERTS_PER_QUAD * 2])
  })

  it('copies vertex attributes verbatim (no repacking on the CPU)', () => {
    const buffer = new GlobalLegacyBufferGPU({ initialCapacityQuads: 64 })
    const geo = geometry(2, 5)
    buffer.addSection('a', geo, 0, 0, 0)

    const positions = buffer.positions.array as Float32Array
    expect(positions.slice(0, geo.positions.length)).toEqual(geo.positions)
  })

  it('rejects non-quad topology instead of corrupting the buffer', () => {
    const buffer = new GlobalLegacyBufferGPU({ initialCapacityQuads: 64 })
    const geo = geometry(1)
    // A lone triangle: 3 indices, not a multiple of 6.
    const broken = { ...geo, indices: new Uint32Array([0, 1, 2]) }

    expect(buffer.addSection('a', broken, 0, 0, 0)).toBe(false)
    expect(buffer.sectionCount).toBe(0)
  })

  it('publishes quad ranges for the cull pass', () => {
    const buffer = new GlobalLegacyBufferGPU({ initialCapacityQuads: 64 })
    buffer.addSection('a', geometry(4), 1, 2, 3)

    const meta = metaOf(buffer)
    expect(meta[3]).toBe(0) // quadStart
    expect(meta[4]).toBe(4) // quadCount
  })

  it('zeroes metadata on removal so the cull pass skips the section', () => {
    const buffer = new GlobalLegacyBufferGPU({ initialCapacityQuads: 64 })
    buffer.addSection('a', geometry(4), 0, 0, 0)
    buffer.removeSection('a')

    expect(metaOf(buffer)[4]).toBe(0)
    expect(buffer.sectionCount).toBe(0)
    expect(buffer.usedQuads).toBe(0)
  })

  it('reuses a freed range for a later same-size section', () => {
    const buffer = new GlobalLegacyBufferGPU({ initialCapacityQuads: 64 })
    buffer.addSection('a', geometry(4), 0, 0, 0)
    buffer.addSection('b', geometry(4), 1, 0, 0)
    buffer.removeSection('a')
    buffer.addSection('c', geometry(4), 2, 0, 0)

    expect(buffer.usedQuads).toBe(8)
    expect(buffer.sectionCount).toBe(2)
  })

  it('refuses to grow past the adapter capacity ceiling', () => {
    const buffer = new GlobalLegacyBufferGPU({ initialCapacityQuads: 4, maxCapacityQuads: 4 })
    expect(buffer.addSection('a', geometry(4), 0, 0, 0)).toBe(true)
    expect(buffer.addSection('b', geometry(1), 1, 0, 0)).toBe(false)
  })

  it('overwrites in place when re-added at the same size', () => {
    const buffer = new GlobalLegacyBufferGPU({ initialCapacityQuads: 64 })
    buffer.addSection('a', geometry(2, 1), 0, 0, 0)
    const startBefore = metaOf(buffer)[3]

    buffer.addSection('a', geometry(2, 9), 0, 0, 0)

    expect(metaOf(buffer)[3]).toBe(startBefore)
    expect((buffer.positions.array as Float32Array)[0]).toBe(900)
    expect(buffer.sectionCount).toBe(1)
  })
})
