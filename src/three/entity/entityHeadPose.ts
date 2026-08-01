export type EntityHeadPoseInput = {
  pitch?: unknown
  yaw?: unknown
  headYaw?: unknown
}

export type EntityHeadPose = {
  pitch: number
  headYaw: number
}

export function resolveEntityHeadPose(entity: EntityHeadPoseInput): EntityHeadPose {
  const pitch = typeof entity.pitch === 'number' && Number.isFinite(entity.pitch) ? entity.pitch : 0
  const headYaw =
    typeof entity.headYaw === 'number' && Number.isFinite(entity.headYaw)
      ? entity.headYaw
      : typeof entity.yaw === 'number' && Number.isFinite(entity.yaw)
        ? entity.yaw
        : 0
  return { pitch, headYaw }
}
