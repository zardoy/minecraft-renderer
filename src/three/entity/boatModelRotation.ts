/** OBJ boat models face -X at yaw=0; physics forward is -Z → rotate mesh locally. */
export const BOAT_MESH_YAW_OFFSET = -Math.PI / 2

export function isBoatEntityName(entityName: string | undefined): boolean {
  if (!entityName) return false
  const name = entityName.toLowerCase()
  if (name === 'boat' || name === 'chest_boat') return true
  return name.endsWith('_boat') || name.endsWith('_raft')
}

export function getBoatMeshYawOffset(entityName: string | undefined): number | null {
  return isBoatEntityName(entityName) ? BOAT_MESH_YAW_OFFSET : null
}
