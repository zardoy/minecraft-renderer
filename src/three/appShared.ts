import { BlockModel } from 'mc-assets/dist/types'
import { ItemSpecificContextProperties } from '../playerState/types'
import { PlayerStateRenderer } from '../playerState/playerState'
import { GeneralInputItem, getItemModelName } from '../lib/items'
import { ResourcesManagerTransferred } from '../resourcesManager'
import { renderSlot } from './renderSlot'

export const getItemUv = (item: Record<string, any>, specificProps: ItemSpecificContextProperties, resourcesManager: ResourcesManagerTransferred, playerState: PlayerStateRenderer): {
  u: number
  v: number
  su: number
  sv: number
  renderInfo?: ReturnType<typeof renderSlot>
  // texture: ImageBitmap
  modelName: string
} | {
  resolvedModel: BlockModel
  modelName: string
} => {
  const resources = resourcesManager.currentResources
  if (!resources) throw new Error('Resources not loaded')
  const idOrName = item.itemId ?? item.blockId ?? item.name
  const { blockState } = item
  try {
    const name =
      blockState
        ? globalThis.loadedData.blocksByStateId[blockState]?.name
        : typeof idOrName === 'number' ? globalThis.loadedData.items[idOrName]?.name : idOrName
    if (!name) throw new Error(`Item not found: ${idOrName}`)

    const model = getItemModelName({
      ...item,
      name,
    } as GeneralInputItem, specificProps, resourcesManager, playerState)

    const renderInfo = renderSlot({
      modelName: model,
    }, resourcesManager, false, true)

    if (!renderInfo) throw new Error(`Failed to get render info for item ${name}`)

    const img = renderInfo.texture === 'blocks' ? resources.blocksAtlasImage : resources.itemsAtlasImage

    if (renderInfo.blockData) {
      return {
        resolvedModel: renderInfo.blockData.resolvedModel,
        modelName: renderInfo.modelName!
      }
    }
    if (renderInfo.slice) {
      // Get slice coordinates from either block or item texture
      const [x, y, w, h] = renderInfo.slice
      const [u, v, su, sv] = [x / img.width, y / img.height, (w / img.width), (h / img.height)]
      return {
        u, v, su, sv,
        renderInfo,
        // texture: img,
        modelName: renderInfo.modelName!
      }
    }

    throw new Error(`Invalid render info for item ${name}`)
  } catch (err) {
    reportError?.(err)
    // Return default UV coordinates for missing texture
    return {
      u: 0,
      v: 0,
      su: 16 / resources.blocksAtlasImage.width,
      sv: 16 / resources.blocksAtlasImage.width,
      // texture: resources.blocksAtlasImage,
      modelName: 'missing'
    }
  }
}
