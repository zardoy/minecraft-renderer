// Import placeholders - replace with actual imports for your environment
import {
  ItemRenderer,
  Identifier,
  ItemStack,
  NbtString,
  Structure,
  StructureRenderer,
  ItemRendererResources,
  BlockDefinition,
  BlockModel,
  TextureAtlas,
  Resources,
  ItemModel
} from 'deepslate'
import { AssetsParser } from 'mc-assets/dist/assetsParser'
import { getLoadedImage, versionToNumber } from 'mc-assets/dist/utils'
import { BlockModel as BlockModelMcAssets, AtlasParser } from 'mc-assets'
import { getLoadedBlockstatesStore, getLoadedModelsStore } from 'mc-assets/dist/stores'
import { makeTextureAtlas } from 'mc-assets/dist/atlasCreator'
import { proxy, ref } from 'valtio'
import { getItemDefinition } from 'mc-assets/dist/itemDefinitions'
import { AppViewer } from '../graphicsBackend/appViewer'

export const getNonFullBlocksModels = (appViewer: AppViewer) => {
  let version = appViewer.resourcesManager.currentResources!.version ?? 'latest'
  if (versionToNumber(version) < versionToNumber('1.13')) version = '1.13'
  const itemsDefinitions = appViewer.resourcesManager.currentResources!.itemsDefinitionsStore.data.latest
  const blockModelsResolved = {} as Record<string, any>
  const itemsModelsResolved = {} as Record<string, any>
  const fullBlocksWithNonStandardDisplay = [] as string[]
  const handledItemsWithDefinitions = new Set()
  const assetsParser = new AssetsParser(
    version,
    getLoadedBlockstatesStore(appViewer.resourcesManager.currentResources!.blockstatesModels),
    getLoadedModelsStore(appViewer.resourcesManager.currentResources!.blockstatesModels)
  )

  const standardGuiDisplay = {
    rotation: [30, 225, 0],
    translation: [0, 0, 0],
    scale: [0.625, 0.625, 0.625]
  }

  const arrEqual = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i])
  const addModelIfNotFullblock = (name: string, model: BlockModelMcAssets) => {
    if (blockModelsResolved[name]) return
    if (!model?.elements?.length) return
    const isFullBlock = model.elements.length === 1 && arrEqual(model.elements[0].from, [0, 0, 0]) && arrEqual(model.elements[0].to, [16, 16, 16])
    if (isFullBlock) return
    const hasBetterPrerender = assetsParser.blockModelsStore.data.latest[`item/${name}`]?.textures?.['layer0']?.startsWith('invsprite_')
    if (hasBetterPrerender) return
    model['display'] ??= {}
    model['display']['gui'] ??= standardGuiDisplay
    blockModelsResolved[name] = model
  }

  for (const [name, definition] of Object.entries(itemsDefinitions)) {
    const item = getItemDefinition(appViewer.resourcesManager.currentResources!.itemsDefinitionsStore, {
      version,
      name,
      properties: {
        'minecraft:display_context': 'gui'
      }
    })
    if (item) {
      const { resolvedModel } = assetsParser.getResolvedModelsByModel((item.special ? name : item.model).replace('minecraft:', '')) ?? {}
      if (resolvedModel) {
        handledItemsWithDefinitions.add(name)
      }
      if (resolvedModel?.elements) {
        let hasStandardDisplay = true
        if (resolvedModel['display']?.gui) {
          hasStandardDisplay =
            arrEqual(resolvedModel['display'].gui.rotation, standardGuiDisplay.rotation) &&
            arrEqual(resolvedModel['display'].gui.translation, standardGuiDisplay.translation) &&
            arrEqual(resolvedModel['display'].gui.scale, standardGuiDisplay.scale)
        }

        addModelIfNotFullblock(name, resolvedModel)

        if (!blockModelsResolved[name] && !hasStandardDisplay) {
          fullBlocksWithNonStandardDisplay.push(name)
        }
        const notSideLight = resolvedModel['gui_light'] && resolvedModel['gui_light'] !== 'side'
        if (!hasStandardDisplay || notSideLight) {
          blockModelsResolved[name] = resolvedModel
        }
      }
      if (!blockModelsResolved[name] && item.tints && resolvedModel) {
        resolvedModel['tints'] = item.tints
        if (resolvedModel.elements) {
          blockModelsResolved[name] = resolvedModel
        } else {
          itemsModelsResolved[name] = resolvedModel
        }
      }
    }
  }

  for (const [name, blockstate] of Object.entries(appViewer.resourcesManager.currentResources!.blockstatesModels.blockstates.latest)) {
    if (handledItemsWithDefinitions.has(name)) {
      continue
    }
    const resolvedModel = assetsParser.getResolvedModelFirst({ name: name.replace('minecraft:', ''), properties: {} }, true)
    if (resolvedModel) {
      addModelIfNotFullblock(name, resolvedModel[0])
    }
  }

  return {
    blockModelsResolved,
    itemsModelsResolved
  }
}

// customEvents.on('gameLoaded', () => {
//   const res = getNonFullBlocksModels()
// })

const RENDER_SIZE = 64

const generateItemsGui = async (appViewer: AppViewer, models: Record<string, BlockModelMcAssets>, isItems = false) => {
  const { currentResources } = appViewer.resourcesManager
  const imgBitmap = isItems ? currentResources!.itemsAtlasImage : currentResources!.blocksAtlasImage
  const canvasTemp = document.createElement('canvas')
  canvasTemp.width = imgBitmap.width
  canvasTemp.height = imgBitmap.height
  canvasTemp.style.imageRendering = 'pixelated'
  const ctx = canvasTemp.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(imgBitmap, 0, 0)

  const atlasParser = isItems ? appViewer.resourcesManager.itemsAtlasParser : appViewer.resourcesManager.blocksAtlasParser
  const textureAtlas = new TextureAtlas(
    ctx.getImageData(0, 0, imgBitmap.width, imgBitmap.height),
    Object.fromEntries(
      Object.entries(atlasParser.atlas.latest.textures).map(([key, value]) => {
        return [key, [value.u, value.v, value.u + (value.su ?? atlasParser.atlas.latest.suSv), value.v + (value.sv ?? atlasParser.atlas.latest.suSv)]] as [
          string,
          [number, number, number, number]
        ]
      })
    )
  )

  const PREVIEW_ID = Identifier.parse('preview:preview')
  const PREVIEW_DEFINITION = new BlockDefinition({ '': { model: PREVIEW_ID.toString() } }, undefined)

  let textureWasRequested = false
  let modelData: any
  let currentModelName: string | undefined
  const resources: ItemRendererResources = {
    getBlockModel(id) {
      if (id.equals(PREVIEW_ID)) {
        return BlockModel.fromJson(modelData ?? {})
      }
      return null
    },
    getTextureUV(texture) {
      textureWasRequested = true
      return textureAtlas.getTextureUV(
        texture.toString().replace('minecraft:', '').replace('block/', '').replace('item/', '').replace('blocks/', '').replace('items/', '') as any
      )
    },
    getTextureAtlas() {
      return textureAtlas.getTextureAtlas()
    },
    getItemComponents(id) {
      return new Map()
    },
    getItemModel(id) {
      // const isSpecial = currentModelName === 'shield' || currentModelName === 'conduit' || currentModelName === 'trident'
      const isSpecial = false
      if (id.equals(PREVIEW_ID)) {
        return ItemModel.fromJson({
          type: isSpecial ? 'minecraft:special' : 'minecraft:model',
          model: isSpecial
            ? {
                type: currentModelName
              }
            : PREVIEW_ID.toString(),
          base: PREVIEW_ID.toString(),
          tints: modelData?.tints
        })
      }
      return null
    }
  }

  const canvas = document.createElement('canvas')
  canvas.width = RENDER_SIZE
  canvas.height = RENDER_SIZE
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })
  if (!gl) {
    throw new Error('Cannot get WebGL2 context')
  }

  function resetGLContext(gl) {
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)
  }

  // const includeOnly = ['powered_repeater', 'wooden_door']
  const includeOnly = [] as string[]

  const images: Record<string, HTMLImageElement> = {}
  const item = new ItemStack(
    PREVIEW_ID,
    1,
    new Map(
      Object.entries({
        'minecraft:item_model': new NbtString(PREVIEW_ID.toString())
      })
    )
  )
  const renderer = new ItemRenderer(gl, item, resources, { display_context: 'gui' })
  const missingTextures = new Set()
  for (const [modelName, model] of Object.entries(models)) {
    textureWasRequested = false
    if (includeOnly.length && !includeOnly.includes(modelName)) continue

    const patchMissingTextures = () => {
      for (const element of model.elements ?? []) {
        for (const [faceName, face] of Object.entries(element.faces)) {
          if (face.texture.startsWith('#')) {
            missingTextures.add(`${modelName} ${faceName}: ${face.texture}`)
            face.texture = 'block/unknown'
          }
        }
      }
    }
    patchMissingTextures()
    // TODO eggs

    modelData = model
    currentModelName = modelName
    resetGLContext(gl)
    if (!modelData) continue
    renderer.setItem(item, { display_context: 'gui' })
    renderer.drawItem()
    if (!textureWasRequested) continue
    const url = canvas.toDataURL()
    // eslint-disable-next-line no-await-in-loop
    const img = await getLoadedImage(url)
    images[modelName] = img
  }

  if (missingTextures.size) {
    console.warn(`[guiRenderer] Missing textures in ${[...missingTextures].join(', ')}`)
  }

  return images
}

/**
 * @mainThread
 */
const generateAtlas = async (appViewer: AppViewer, images: Record<string, HTMLImageElement>) => {
  const atlas = makeTextureAtlas({
    input: Object.keys(images),
    tileSize: RENDER_SIZE,
    getLoadedImage(name) {
      return {
        image: images[name]
      }
    }
  })

  // const atlasParser = new AtlasParser({ latest: atlas.json }, atlas.canvas.toDataURL())
  // const a = document.createElement('a')
  // a.href = await atlasParser.createDebugImage(true)
  // a.download = 'blocks_atlas.png'
  // a.click()

  appViewer.resourcesManager.currentResources!.guiAtlas = {
    json: atlas.json,
    image: await createImageBitmap(atlas.canvas)
  }

  return atlas
}

export const generateGuiAtlas = async (appViewer: AppViewer) => {
  const { blockModelsResolved, itemsModelsResolved } = getNonFullBlocksModels(appViewer)

  // Generate blocks atlas
  console.time('generate blocks gui atlas')
  const blockImages = await generateItemsGui(appViewer, blockModelsResolved, false)
  console.timeEnd('generate blocks gui atlas')
  console.time('generate items gui atlas')
  const itemImages = await generateItemsGui(appViewer, itemsModelsResolved, true)
  console.timeEnd('generate items gui atlas')
  await generateAtlas(appViewer, { ...blockImages, ...itemImages })
  appViewer.resourcesManager.currentResources!.guiAtlasVersion++
  // await generateAtlas(blockImages)
}
