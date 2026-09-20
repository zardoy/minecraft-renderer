import { ItemSelector } from 'mc-assets/dist/itemDefinitions'

export type GameMode = 'survival' | 'creative' | 'adventure' | 'spectator'

export interface Team {
  team?: any
  id: string
  name: string
  color: string
  prefix: string
  suffix: string
  players: string[]
}

export interface HandItemBlock {
  name?: string
  properties?: Record<string, any>
  fullItem?: any
  type: 'block' | 'item' | 'hand'
  id?: number
}

export type MovementState = 'NOT_MOVING' | 'WALKING' | 'SPRINTING' | 'SNEAKING'
export type ItemSpecificContextProperties = Partial<
  Pick<ItemSelector['properties'], 'minecraft:using_item' | 'minecraft:use_duration' | 'minecraft:use_cycle' | 'minecraft:display_context'>
>
export type CameraPerspective = 'first_person' | 'third_person_back' | 'third_person_front'

export type BlockShape = { position: { x: number; y: number; z: number }; width: number; height: number; depth: number }
export type BlocksShapes = BlockShape[]
export type UseItemAction = 'EAT' | 'DRINK' | 'BOW' | 'CROSSBOW' | 'SHIELD' | 'NONE'

export type UseItemParticleEffect = 'food' | 'drink' | 'none'

export type UseItemStatus = 'active' | 'awaitingCompletion' | 'completed' | 'cancelled'

export interface UseItemSnapshot {
  name: string
  durationTicks: number
  action: UseItemAction
  particleEffect: UseItemParticleEffect
}

export interface UseItemSession {
  id: number
  itemSnapshot: UseItemSnapshot
  hand: 0 | 1
  action: UseItemAction
  durationTicks: number
  elapsedTicks: number
  status: UseItemStatus
}
