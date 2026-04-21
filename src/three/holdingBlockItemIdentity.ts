import type { HandItemBlock, ItemSpecificContextProperties } from '../playerState/types'
import type { WorldRendererThree } from './worldRendererThree'

export const getFirstPersonItemSpecificProps = (worldRenderer: WorldRendererThree): ItemSpecificContextProperties => ({
  'minecraft:display_context': 'firstperson',
  'minecraft:use_duration': worldRenderer.playerStateReactive.itemUsageTicks,
  'minecraft:using_item': !!worldRenderer.playerStateReactive.itemUsageTicks,
})

const getFirstPersonItemIdentityProps = (): ItemSpecificContextProperties => ({
  'minecraft:display_context': 'firstperson',
})

export const getHandItemRenderKey = (worldRenderer: WorldRendererThree, handItem?: HandItemBlock) => {
  if (!handItem) return 'empty'
  if (handItem.type === 'hand') return 'hand'

  const itemIdentifier = handItem.name ?? (handItem.id !== undefined ? `#${handItem.id}` : 'unknown')
  if (!worldRenderer.resourcesManager.currentResources) {
    return `${handItem.type}:${itemIdentifier}`
  }

  const renderData = worldRenderer.getItemRenderData({
    ...handItem.fullItem,
    itemId: handItem.id,
  }, getFirstPersonItemIdentityProps())

  return `${handItem.type}:${itemIdentifier}:${renderData.modelName}`
}
