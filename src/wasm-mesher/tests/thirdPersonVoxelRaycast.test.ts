import { test, expect } from 'vitest'
import { raycastVoxelSolid } from '../../three/thirdPersonVoxelRaycast'

const solid = (blocks: Set<string>) => (x: number, y: number, z: number) => blocks.has(`${x},${y},${z}`)

test('raycastVoxelSolid: straight-back ray hits wall', () => {
  const blocks = solid(new Set(['5,5,5', '5,5,6', '5,5,7', '5,5,8']))
  const hit = raycastVoxelSolid(0.5, 5.5, 5.5, 1, 0, 0, 10, 0.25, 0.05, blocks)
  expect(hit).toBeDefined()
  expect(hit!.blockX).toBe(5)
  expect(hit!.distance).toBeGreaterThan(0)
  expect(hit!.distance).toBeLessThan(5)
})

test('raycastVoxelSolid: diagonal ray through corner seam still hits volume', () => {
  // Pit walls: solid L-shape; eye above pit looks back-down through corner gap in mesh shell.
  const blocks = solid(
    new Set([
      // floor y=5
      '4,5,4',
      '5,5,4',
      '6,5,4',
      '4,5,5',
      '5,5,5',
      '6,5,5',
      // walls
      '4,6,4',
      '4,7,4',
      '5,6,4',
      '6,6,5',
      '6,7,5',
      // surrounding ground (would be hollow in mesh)
      '3,5,3',
      '3,6,3',
      '3,7,3',
      '7,5,7',
      '7,6,7',
      '7,7,7'
    ])
  )
  const dx = -0.6
  const dy = -0.5
  const dz = -0.6
  const len = Math.hypot(dx, dy, dz)
  const hit = raycastVoxelSolid(5.5, 7.5, 5.5, dx / len, dy / len, dz / len, 4, 0.25, 0.05, blocks)
  expect(hit).toBeDefined()
  expect(hit!.distance).toBeLessThan(4)
})

test('raycastVoxelSolid: passes through air and decorative pass-through is caller responsibility', () => {
  const blocks = solid(new Set(['0,0,3']))
  const hit = raycastVoxelSolid(0.5, 0.5, 0.5, 0, 0, 1, 10, 0.25, 0.05, blocks)
  expect(hit?.blockZ).toBe(3)
})

test('raycastVoxelSolid: downward ray hits floor slab', () => {
  const blocks = solid(new Set(['0,4,0']))
  const hit = raycastVoxelSolid(0.5, 6.5, 0.5, 0, -1, 0, 10, 0.25, 0.05, blocks)
  expect(hit).toBeDefined()
  expect(hit!.blockY).toBe(4)
  expect(hit!.distance).toBeCloseTo(1.25, 1)
})
