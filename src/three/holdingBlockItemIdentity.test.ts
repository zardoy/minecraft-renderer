import { expect, test, vi } from 'vitest'
import { getHandItemRenderKey } from './holdingBlockItemIdentity'

test('hand item render key ignores live use state but keeps first-person display context', () => {
  const getItemRenderData = vi.fn(() => ({ modelName: 'item/bow' }))
  const worldRenderer = {
    playerStateReactive: {
      itemUsageTicks: 20
    },
    resourcesManager: {
      currentResources: {}
    },
    getItemRenderData
  } as any

  const handItem = {
    type: 'item',
    id: 261,
    name: 'minecraft:bow',
    fullItem: {
      count: 1
    }
  } as const

  const activeKey = getHandItemRenderKey(worldRenderer, handItem)
  worldRenderer.playerStateReactive.itemUsageTicks = 0
  const idleKey = getHandItemRenderKey(worldRenderer, handItem)

  expect(activeKey).toBe(idleKey)
  expect(getItemRenderData).toHaveBeenNthCalledWith(
    1,
    {
      ...handItem.fullItem,
      itemId: handItem.id
    },
    {
      'minecraft:display_context': 'firstperson'
    }
  )
  expect(getItemRenderData).toHaveBeenNthCalledWith(
    2,
    {
      ...handItem.fullItem,
      itemId: handItem.id
    },
    {
      'minecraft:display_context': 'firstperson'
    }
  )
})
