/**
 * Player State - Initial player state for renderer.
 */

import { proxy } from 'valtio'
import { PlayerStateReactive } from '../playerState/playerState'

/**
 * Get initial player state with default values.
 */
export const getInitialPlayerState = (): PlayerStateReactive =>
  proxy({
    playerSkin: undefined,
    inWater: false,
    waterBreathing: false,
    backgroundColor: [0, 0, 0] as [number, number, number],
    ambientLight: 0,
    directionalLight: 0,
    eyeHeight: 0,
    gameMode: undefined,
    lookingAtBlock: undefined,
    diggingBlock: undefined,
    movementState: 'NOT_MOVING',
    onGround: true,
    sneaking: false,
    flying: false,
    sprinting: false,
    walkDist: 0,
    prevWalkDist: 0,
    bob: 0,
    prevBob: 0,
    itemUsageTicks: 0,
    username: '',
    onlineMode: false,
    cardinalLight: 'default',
    lightingDisabled: false,
    shouldHideHand: false,
    heldItemMain: undefined,
    heldItemOff: undefined,
    perspective: 'first_person',
    onFire: false,
    fovMultiplier: 1,
    cameraSpectatingEntity: undefined,
    team: undefined
  })

/**
 * Get player state utils.
 */
export const getPlayerStateUtils = (reactive: PlayerStateReactive) => ({
  isSpectator() {
    return reactive.gameMode === 'spectator'
  },
  isSpectatingEntity() {
    return reactive.cameraSpectatingEntity !== undefined && reactive.gameMode === 'spectator'
  },
  isThirdPerson() {
    if (this.isSpectatingEntity()) return false
    return reactive.perspective === 'third_person_back' || reactive.perspective === 'third_person_front'
  }
})

/**
 * Get initial player state for renderer.
 */
export const getInitialPlayerStateRenderer = () => ({
  reactive: getInitialPlayerState()
})
