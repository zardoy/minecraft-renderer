import { expect, test } from 'vitest'
import { BOAT_MESH_YAW_OFFSET, getBoatMeshYawOffset, isBoatEntityName } from './boatModelRotation'

test('boat mesh yaw offset is -90°', () => {
  expect(BOAT_MESH_YAW_OFFSET).toBe(-Math.PI / 2)
})

test.each([
  'boat',
  'chest_boat',
  'oak_boat',
  'spruce_boat',
  'birch_boat',
  'jungle_boat',
  'acacia_boat',
  'dark_oak_boat',
  'mangrove_boat',
  'cherry_boat',
  'bamboo_raft'
])('detects boat entity %s', name => {
  expect(isBoatEntityName(name)).toBe(true)
  expect(getBoatMeshYawOffset(name)).toBe(BOAT_MESH_YAW_OFFSET)
})

test.each(['minecart', 'horse', 'player', 'item', 'oak_boat_with_chest'])('ignores non-boat entity %s', name => {
  expect(isBoatEntityName(name)).toBe(false)
  expect(getBoatMeshYawOffset(name)).toBeNull()
})
