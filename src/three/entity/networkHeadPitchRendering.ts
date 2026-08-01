import type { PlayerObjectType } from '../../lib/createPlayerObject'

export type NetworkHeadRotationState = {
  _networkHeadPitch?: number
  _networkHeadYaw?: number
  _remoteBoatRotationApplied?: boolean
}

/** @deprecated Use NetworkHeadRotationState */
export type NetworkHeadPitchState = NetworkHeadRotationState

export function storeNetworkHeadPitch(userData: NetworkHeadRotationState, pitch: unknown): void {
  if (typeof pitch === 'number' && Number.isFinite(pitch)) {
    userData._networkHeadPitch = pitch
  }
}

export function storeNetworkHeadYaw(userData: NetworkHeadRotationState, headYaw: unknown, fallbackYaw?: unknown): void {
  if (typeof headYaw === 'number' && Number.isFinite(headYaw)) {
    userData._networkHeadYaw = headYaw
    return
  }
  if (typeof fallbackYaw === 'number' && Number.isFinite(fallbackYaw)) {
    userData._networkHeadYaw = fallbackYaw
  }
}

export function getNetworkHeadPitch(userData: NetworkHeadRotationState): number {
  const pitch = userData._networkHeadPitch
  return typeof pitch === 'number' && Number.isFinite(pitch) ? pitch : 0
}

export function applyNetworkHeadPitch(playerObject: PlayerObjectType, userData: NetworkHeadRotationState): void {
  const pitch = userData._networkHeadPitch
  if (typeof pitch !== 'number' || !Number.isFinite(pitch)) return
  playerObject.skin.head.rotation.y = 0
  playerObject.skin.head.rotation.x = -pitch
}

export function restoreGenericRemotePlayerHeadRotation(playerObject: PlayerObjectType, userData: NetworkHeadRotationState): void {
  playerObject.skin.head.rotation.y = 0
  applyNetworkHeadPitch(playerObject, userData)
}
