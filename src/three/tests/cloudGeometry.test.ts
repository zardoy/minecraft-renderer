import { expect, test } from 'vitest'
import { buildCloudGeometry, CLOUD_CELL_SIZE, CLOUD_THICKNESS, type CloudCover } from '../cloudGeometry'

function coverOf(rows: string[]): CloudCover {
  const height = rows.length
  const width = rows[0].length
  const filled = new Uint8Array(width * height)
  rows.forEach((row, z) => [...row].forEach((ch, x) => (filled[z * width + x] = ch === '#' ? 1 : 0)))
  return { width, height, filled }
}

const quadCount = (data: ReturnType<typeof buildCloudGeometry>) => data.indices.length / 6

/** Normal of triangle `tri` from the index buffer. */
function triangleNormal(data: ReturnType<typeof buildCloudGeometry>, tri: number): [number, number, number] {
  const p = (k: number) => {
    const v = data.indices[tri * 3 + k] * 3
    return [data.positions[v], data.positions[v + 1], data.positions[v + 2]]
  }
  const [a, b, c] = [p(0), p(1), p(2)]
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
}

test('a lone cell is a closed box of six faces', () => {
  const data = buildCloudGeometry(coverOf(['....', '.#..', '....', '....']), 1, 1, 0)
  expect(quadCount(data)).toBe(6)
  expect(data.positions.length / 3).toBe(24)
  expect(data.shades.length).toBe(24)
})

test('empty sky produces no geometry', () => {
  expect(buildCloudGeometry(coverOf(['....', '....']), 0, 0, 3).indices.length).toBe(0)
})

test('faces between adjacent cells are not emitted', () => {
  // top + bottom for each cell, two side faces each along z, and one end cap each along x.
  const data = buildCloudGeometry(coverOf(['....', '.##.', '....', '....']), 1, 1, 1)
  expect(quadCount(data)).toBe(2 + 2 + 4 + 2)
})

test('every face winds counter-clockwise seen from outside the box', () => {
  const data = buildCloudGeometry(coverOf(['....', '.#..', '....', '....']), 1, 1, 0)
  const normals = new Set<string>()
  for (let tri = 0; tri < data.indices.length / 3; tri++) {
    const n = triangleNormal(data, tri)
    // Only one axis is non-zero for an axis-aligned face.
    const nonZero = n.filter(c => Math.abs(c) > 1e-6)
    expect(nonZero).toHaveLength(1)
    normals.add(n.map(c => Math.sign(c)).join(','))
  }
  expect([...normals].sort()).toEqual(['-1,0,0', '0,-1,0', '0,0,-1', '0,0,1', '0,1,0', '1,0,0'].sort())
})

test('faces point away from the cell centre', () => {
  const data = buildCloudGeometry(coverOf(['.#', '..']), 1, 0, 0)
  const centre = [CLOUD_CELL_SIZE / 2, CLOUD_THICKNESS / 2, CLOUD_CELL_SIZE / 2]
  for (let tri = 0; tri < data.indices.length / 3; tri++) {
    const n = triangleNormal(data, tri)
    const v = data.indices[tri * 3] * 3
    const toFace = [data.positions[v] - centre[0], data.positions[v + 1] - centre[1], data.positions[v + 2] - centre[2]]
    expect(n[0] * toFace[0] + n[1] * toFace[1] + n[2] * toFace[2]).toBeGreaterThan(0)
  }
})

test('the slab is four blocks thick and cells are 12 blocks wide', () => {
  const data = buildCloudGeometry(coverOf(['#']), 0, 0, 0)
  const xs = [...data.positions].filter((_, i) => i % 3 === 0)
  const ys = [...data.positions].filter((_, i) => i % 3 === 1)
  expect(Math.max(...ys) - Math.min(...ys)).toBe(4)
  expect(Math.max(...xs) - Math.min(...xs)).toBe(12)
})

test('cell lookup wraps like the texture, including negative indices', () => {
  const cover = coverOf(['#...', '....'])
  // Cells (-4, 0) and (4, 2) alias texel (0, 0); a lone filled texel yields exactly one box per alias.
  expect(quadCount(buildCloudGeometry(cover, -4, 0, 0))).toBe(6)
  expect(quadCount(buildCloudGeometry(cover, 4, 2, 0))).toBe(6)
  expect(quadCount(buildCloudGeometry(cover, 1, 0, 0))).toBe(0)
})

test('shading matches vanilla: top brightest, bottom darkest, sides in between', () => {
  const data = buildCloudGeometry(coverOf(['....', '.#..', '....', '....']), 1, 1, 0)
  expect([...new Set(data.shades)].sort()).toEqual([0.7, 0.8, 0.9, 1].map(Math.fround).sort())
})
