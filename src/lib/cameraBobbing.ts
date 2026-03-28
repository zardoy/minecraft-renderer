export interface CameraBobResult {
  position: { x: number; y: number }
  rotation: { x: number; z: number }
}

export interface CameraBobInput {
  walkDist: number
  prevWalkDist: number
  bob: number
  prevBob: number
  partialTick: number
}

const DEG_TO_RAD = Math.PI / 180

export function computeCameraBob (input: CameraBobInput): CameraBobResult {
  const { walkDist, prevWalkDist, bob, prevBob, partialTick } = input

  // Vanilla uses "backwards interpolation": -(walkDist + delta * partialTick)
  // See ClientAvatarState.getBackwardsInterpolatedWalkDistance()
  const walkDelta = walkDist - prevWalkDist
  const interpolatedWalkDist = -(walkDist + walkDelta * partialTick)
  const interpolatedBob = prevBob + (bob - prevBob) * partialTick

  const sinWalk = Math.sin(interpolatedWalkDist * Math.PI)
  const cosWalk = Math.cos(interpolatedWalkDist * Math.PI)

  return {
    position: {
      x: sinWalk * interpolatedBob * 0.5,
      y: -Math.abs(cosWalk * interpolatedBob)
    },
    rotation: {
      x: Math.abs(Math.cos(interpolatedWalkDist * Math.PI - 0.2) * interpolatedBob) * 5 * DEG_TO_RAD,
      z: sinWalk * interpolatedBob * 3 * DEG_TO_RAD
    }
  }
}
