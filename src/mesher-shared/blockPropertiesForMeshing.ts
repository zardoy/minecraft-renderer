import { Vec3 } from 'vec3'
import type { WorldBlockProvider } from 'mc-assets/dist/worldBlockProvider'
import legacyJson from '../lib/preflatMap.json'
import type { World, WorldBlock as Block } from './world'

const calculatedBlocksEntries = Object.entries(legacyJson.clientCalculatedBlocks)

/**
 * Block name + properties for model lookup. Only runs neighbor/preflat work when
 * `world.preflat` (legacy); modern block-state worlds use `fromStateId` only.
 */
export function resolveBlockPropertiesForMeshing(
  world: World | undefined,
  cursor: Vec3,
  blockProvider: WorldBlockProvider,
  blockStateId: number,
  PrismarineBlockCtor: { fromStateId: (id: number, biome: number) => Block }
): { name: string; properties: Record<string, unknown> } {
  if (world?.preflat) {
    const block = world.getBlock(cursor, blockProvider, {})
    if (block) {
      let properties: Record<string, unknown> = { ...block.getProperties() }
      const patch = preflatBlockCalculation(block, world, cursor)
      if (patch) properties = { ...properties, ...patch }
      return { name: block.name, properties }
    }
  }
  const fromState = PrismarineBlockCtor.fromStateId(blockStateId, 1)
  return { name: fromState.name, properties: fromState.getProperties() }
}

export function preflatBlockCalculation(block: Block, world: World, position: Vec3) {
  const type = calculatedBlocksEntries.find(([name, blocks]) => blocks.includes(block.name))?.[0]
  if (!type) return
  switch (type) {
    case 'directional': {
      const isSolidConnection = !block.name.includes('redstone') && !block.name.includes('tripwire')
      const neighbors = [
        world.getBlock(position.offset(0, 0, 1)),
        world.getBlock(position.offset(0, 0, -1)),
        world.getBlock(position.offset(1, 0, 0)),
        world.getBlock(position.offset(-1, 0, 0))
      ]
      const props = {}
      let changed = false
      for (const [i, neighbor] of neighbors.entries()) {
        const isConnectedToSolid = isSolidConnection ? neighbor && !neighbor.transparent : false
        if (isConnectedToSolid || neighbor?.name === block.name) {
          props[['south', 'north', 'east', 'west'][i]] = 'true'
          changed = true
        }
      }
      return changed ? props : undefined
    }
    case 'block_snowy': {
      const aboveIsSnow = world.getBlock(position.offset(0, 1, 0))?.name === 'snow'
      if (aboveIsSnow) {
        return {
          snowy: `${aboveIsSnow}`
        }
      } else {
        return
      }
    }
    case 'door': {
      const { half } = block.getProperties()
      if (half === 'upper') {
        const lower = world.getBlock(position.offset(0, -1, 0))
        if (lower?.name === block.name) {
          return {
            ...lower.getProperties(),
            half: 'upper'
          }
        }
      }
    }
  }
}
