import { proxy } from 'valtio'
import type { GameMode, HandItemBlock, BlocksShapes, BlockShape, MovementState, CameraPerspective, Team, ItemSpecificContextProperties } from './types'

// edit src/mineflayer/playerState.ts for implementation of player state from mineflayer
export const getInitialPlayerState = () => proxy({
  playerSkin: undefined as string | undefined,
  inWater: false,
  waterBreathing: false,
  backgroundColor: [0, 0, 0] as [number, number, number],
  ambientLight: 0,
  directionalLight: 0,
  eyeHeight: 0,
  gameMode: undefined as GameMode | undefined,
  lookingAtBlock: undefined as {
    x: number
    y: number
    z: number
    face?: number
    shapes: BlocksShapes
  } | undefined,
  diggingBlock: undefined as {
    x: number
    y: number
    z: number
    stage: number
    face?: number
    mergedShape: BlockShape | undefined
  } | undefined,
  movementState: 'NOT_MOVING' as MovementState,
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
  lightingDisabled: false,
  shouldHideHand: false,
  heldItemMain: undefined as HandItemBlock | undefined,
  heldItemOff: undefined as HandItemBlock | undefined,
  perspective: 'first_person' as CameraPerspective,
  onFire: false,

  cameraSpectatingEntity: undefined as number | undefined,

  team: undefined as Team | undefined,
})

export const getPlayerStateUtils = (reactive: PlayerStateReactive) => ({
  isSpectator() {
    return reactive.gameMode === 'spectator'
  },
  isSpectatingEntity() {
    return reactive.cameraSpectatingEntity !== undefined && reactive.gameMode === 'spectator'
  },
  isThirdPerson() {
    if ((this as PlayerStateUtils).isSpectatingEntity()) return false
    return reactive.perspective === 'third_person_back' || reactive.perspective === 'third_person_front'
  }
})

export const getInitialPlayerStateRenderer = () => ({
  reactive: getInitialPlayerState()
})

export type PlayerStateReactive = ReturnType<typeof getInitialPlayerState>
export type PlayerStateUtils = ReturnType<typeof getPlayerStateUtils>

export type PlayerStateRenderer = PlayerStateReactive

export const getItemSelector = (playerState: PlayerStateRenderer, specificProperties: ItemSpecificContextProperties, item?: import('prismarine-item').Item) => {
  return {
    ...specificProperties,
    'minecraft:date': new Date(),
    // "minecraft:context_dimension": bot.entityp,
    // 'minecraft:time': bot.time.timeOfDay / 24_000,
  }
}
