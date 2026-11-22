import { describe, expect, it } from 'vitest'
import { buildElementRotation, buildRotationMatrix, buildXyzRotationMatrix, elemFaces, faceLightCellOffset, matmul3, vecadd3 } from './modelsGeometryCommon'

const origin: [number, number, number] = [8, 8, 8]
const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9))

describe('buildElementRotation', () => {
  it('keeps the axis/angle form working', () => {
    const { localMatrix } = buildElementRotation({ origin, axis: 'y', angle: 90 })
    close(matmul3(localMatrix, [1, 0, 0]), [0, 0, -1])
    close(matmul3(localMatrix, [0, 0, 1]), [1, 0, 0])
  })

  it.each(['x', 'y', 'z'] as const)('x/y/z form about a single axis (%s) equals the axis/angle form', axis => {
    const viaAxis = buildElementRotation({ origin: [2, 5, 11], axis, angle: 37 })
    const viaXyz = buildElementRotation({ origin: [2, 5, 11], [axis]: 37 })
    viaAxis.localMatrix.forEach((row, i) => close(viaXyz.localMatrix[i], row))
    close(viaXyz.localShift, viaAxis.localShift)
  })

  it('applies a combined x/y/z rotation as rotationZYX: z first, then y, then x', () => {
    const rotation = { x: -40.06672, y: 3.06532, z: -2.57258 }
    const vector = [0.3, -1.2, 0.8]
    const stepwise = matmul3(
      buildRotationMatrix('x', rotation.x),
      matmul3(buildRotationMatrix('y', rotation.y), matmul3(buildRotationMatrix('z', rotation.z), vector))
    )
    close(matmul3(buildXyzRotationMatrix(rotation), vector), stepwise)
    // order matters (guards against x, y, z being swapped)
    const reversed = matmul3(
      buildRotationMatrix('z', rotation.z),
      matmul3(buildRotationMatrix('y', rotation.y), matmul3(buildRotationMatrix('x', rotation.x), vector))
    )
    expect(Math.abs(reversed[0] - stepwise[0]) + Math.abs(reversed[1] - stepwise[1])).toBeGreaterThan(1e-3)
  })

  it('rotates around the element origin (the origin stays in place)', () => {
    const rotationOrigin: [number, number, number] = [2.53162, 8.56801, 5.10154]
    const { localMatrix, localShift } = buildElementRotation({ origin: rotationOrigin, x: -40, y: 3, z: -2.5 })
    const moved = matmul3(localMatrix, rotationOrigin).map((v, i) => v + localShift[i])
    close(moved, rotationOrigin)
  })

  it('treats a rotation without any angle as no rotation', () => {
    const { localMatrix, localShift } = buildElementRotation({ origin })
    localMatrix.forEach((row, i) =>
      close(
        row,
        [0, 1, 2].map(j => (i === j ? 1 : 0))
      )
    )
    close(localShift, [0, 0, 0])
  })
})

describe('faceLightCellOffset', () => {
  /** block-local corners (0..1) of one face of an element, like the meshers compute them (no block rotation) */
  const faceCorners = (element: { from: number[]; to: number[]; rotation?: any }, face: keyof typeof elemFaces) => {
    const { localMatrix, localShift } = element.rotation ? buildElementRotation(element.rotation) : { localMatrix: null, localShift: null }
    return elemFaces[face].corners.map(pos => {
      const vertex = [pos[0] ? element.to[0] : element.from[0], pos[1] ? element.to[1] : element.from[1], pos[2] ? element.to[2] : element.from[2]]
      return vecadd3(matmul3(localMatrix, vertex), localShift).map(v => v / 16)
    })
  }
  const dirOf = (face: keyof typeof elemFaces) => elemFaces[face].dir as [number, number, number]

  it('a full block face reads the neighbour in its direction', () => {
    const cube = { from: [0, 0, 0], to: [16, 16, 16] }
    for (const face of ['up', 'down', 'north', 'south', 'east', 'west'] as const) {
      expect(faceLightCellOffset(dirOf(face), faceCorners(cube, face))).toEqual(dirOf(face))
    }
  })

  it('cross plant quads (block/cross: 45 deg about y) read their own cell, so a solid neighbour does not darken them', () => {
    const rotation = { origin: [8, 8, 8], axis: 'y', angle: 45, rescale: true }
    const quadA = { from: [0.8, 0, 8], to: [15.2, 16, 8], rotation }
    const quadB = { from: [8, 0, 0.8], to: [8, 16, 15.2], rotation }
    for (const face of ['north', 'south'] as const) expect(faceLightCellOffset(dirOf(face), faceCorners(quadA, face))).toEqual([0, 0, 0])
    for (const face of ['east', 'west'] as const) expect(faceLightCellOffset(dirOf(face), faceCorners(quadB, face))).toEqual([0, 0, 0])
  })

  it('an inset face (bottom slab top at y=8) reads its own cell, the slab bottom reads the cell below', () => {
    const slab = { from: [0, 0, 0], to: [16, 8, 16] }
    expect(faceLightCellOffset(dirOf('up'), faceCorners(slab, 'up'))).toEqual([0, 0, 0])
    expect(faceLightCellOffset(dirOf('down'), faceCorners(slab, 'down'))).toEqual([0, -1, 0])
  })

  it('a diagonal (non axis aligned) direction never reads a neighbour', () => {
    expect(
      faceLightCellOffset(
        [1, 0, 1],
        [
          [1, 0, 1],
          [1, 1, 1],
          [1, 0, 1],
          [1, 1, 1]
        ]
      )
    ).toEqual([0, 0, 0])
  })
})
