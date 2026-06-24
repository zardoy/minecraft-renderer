import { getRenamedData } from 'mineflayer-mouse/dist/blockRenames'
import { BlockModel } from 'mc-assets'
import { versionToNumber } from 'mc-assets/dist/utils'
import type { ResourcesManagerCommon } from '../resourcesManager'

export type ResolvedItemModelRender = {
  modelName: string
  originalItemName?: string
}

export const renderSlot = (
  model: ResolvedItemModelRender,
  resourcesManager: ResourcesManagerCommon,
  debugIsQuickbar = false,
  fullBlockModelSupport = false
): {
  texture: string
  blockData: (Record<string, { slice; path }> & { resolvedModel: BlockModel }) | null
  scale: number | null
  slice: number[] | null
  modelName: string | null
} => {
  let itemModelName = model.modelName
  const isItem = globalThis.loadedData.itemsByName[itemModelName]

  // #region normalize item name
  if (versionToNumber(resourcesManager.currentResources!.version) < versionToNumber('1.13'))
    itemModelName = getRenamedData(isItem ? 'items' : 'blocks', itemModelName, resourcesManager.currentResources!.version, '1.13.1') as string
  // #endregion

  let itemTexture

  if (!fullBlockModelSupport) {
    const atlas = resourcesManager.currentResources?.guiAtlas?.json
    // todo atlas holds all rendered blocks, not all possibly rendered item/block models, need to request this on demand instead (this is how vanilla works)
    const tryGetAtlasTexture = (name?: string) =>
      name &&
      atlas?.textures[
        name.replace('minecraft:', '').replace('block/', '').replace('blocks/', '').replace('item/', '').replace('items/', '').replace('_inventory', '')
      ]
    const item = tryGetAtlasTexture(itemModelName) ?? tryGetAtlasTexture(model.originalItemName)
    if (item) {
      const x = item.u * atlas.width
      const y = item.v * atlas.height
      return {
        texture: 'gui',
        slice: [x, y, atlas.tileSize, atlas.tileSize],
        scale: 0.25,
        blockData: null,
        modelName: null
      }
    }
  }

  const blockToTopTexture = r => r.top ?? r

  try {
    if (!resourcesManager.currentResources?.itemsRenderer) throw new Error('Items renderer is not available')
    itemTexture =
      resourcesManager.currentResources.itemsRenderer.getItemTexture(itemModelName, {}, false, fullBlockModelSupport) ??
      (model.originalItemName
        ? resourcesManager.currentResources.itemsRenderer.getItemTexture(model.originalItemName, {}, false, fullBlockModelSupport)
        : undefined) ??
      resourcesManager.currentResources.itemsRenderer.getItemTexture('item/missing_texture')!
  } catch (err) {
    // get resourcepack from resource manager
    reportError?.(
      `Failed to render item ${itemModelName} (original: ${model.originalItemName}) on ${resourcesManager.currentResources!.version} (resourcepack: TODO!): ${err.stack}`
    )
    itemTexture = blockToTopTexture(resourcesManager.currentResources!.itemsRenderer!.getItemTexture('errored')!)
  }

  itemTexture ??= blockToTopTexture(resourcesManager.currentResources!.itemsRenderer!.getItemTexture('unknown')!)

  if ('type' in itemTexture) {
    // is item
    return {
      texture: itemTexture.type,
      slice: itemTexture.slice,
      modelName: itemModelName,
      blockData: null,
      scale: null
    }
  } else {
    // is block
    return {
      texture: 'blocks',
      blockData: itemTexture,
      modelName: itemModelName,
      slice: null,
      scale: null
    }
  }
}
