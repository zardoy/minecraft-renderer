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
import { versionToNumber } from 'mc-assets/dist/utils'
import { BlockModel as BlockModelMcAssets, AtlasParser } from 'mc-assets'
import { getLoadedBlockstatesStore, getLoadedModelsStore } from 'mc-assets/dist/stores'
import { proxy, ref } from 'valtio'
import { getItemDefinition } from 'mc-assets/dist/itemDefinitions'
import { AppViewer } from '../graphicsBackend/appViewer'
import { isCurrentResourceGeneration, publishGuiAtlas } from './guiAtlasGeneration'
import { loseWebGLContext } from './webglLifecycle'

export const getNonFullBlocksModels = (appViewer: AppViewer, resources = appViewer.resourcesManager.currentResources!) => {
  let version = resources.version ?? 'latest'
  if (versionToNumber(version) < versionToNumber('1.13')) version = '1.13'
  const itemsDefinitions = resources.itemsDefinitionsStore.data.latest
  const blockModelsResolved = {} as Record<string, any>
  const itemsModelsResolved = {} as Record<string, any>
  const fullBlocksWithNonStandardDisplay = [] as string[]
  const handledItemsWithDefinitions = new Set()
  const assetsParser = new AssetsParser(version, getLoadedBlockstatesStore(resources.blockstatesModels), getLoadedModelsStore(resources.blockstatesModels))

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
    const item = getItemDefinition(resources.itemsDefinitionsStore, {
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

  for (const [name, blockstate] of Object.entries(resources.blockstatesModels.blockstates.latest)) {
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
/** Main-thread time the icon loop may take before it lets the browser draw a frame (the game may already be running). */
const ICON_SLICE_MS = 8

/** Every icon is drawn into its own tile of one shared WebGL canvas, which is read back once as the atlas image. */
type IconTarget = {
  gl: WebGL2RenderingContext
  /** atlas side in pixels (power of two) */
  size: number
  tilesPerRow: number
  /** top-left of each drawn icon in atlas pixels (y down), by name */
  tiles: Record<string, { x: number; y: number; tileIndex: number }>
  nextTile: number
  sliceStart: number
}

const yieldToBrowser = async () =>
  new Promise<void>(resolve => {
    setTimeout(resolve, 0)
  })

const renderIconsIntoAtlas = async (
  appViewer: AppViewer,
  target: IconTarget,
  models: Record<string, BlockModelMcAssets>,
  isItems: boolean,
  currentResources: NonNullable<AppViewer['resourcesManager']['currentResources']>,
  isCurrent: () => boolean
) => {
  const { gl } = target
  const imgBitmap = isItems ? currentResources.itemsAtlasImage : currentResources.blocksAtlasImage
  const canvasTemp = document.createElement('canvas')
  canvasTemp.width = imgBitmap.width
  canvasTemp.height = imgBitmap.height
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
      if (id.equals(PREVIEW_ID)) {
        return ItemModel.fromJson({
          type: 'minecraft:model',
          model: PREVIEW_ID.toString(),
          base: PREVIEW_ID.toString(),
          tints: modelData?.tints
        })
      }
      return null
    }
  }

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
  gl.enable(gl.SCISSOR_TEST)
  gl.clearColor(0, 0, 0, 0)
  for (const [modelName, model] of Object.entries(models)) {
    if (!model) continue
    if (performance.now() - target.sliceStart > ICON_SLICE_MS) {
      // eslint-disable-next-line no-await-in-loop
      await yieldToBrowser()
      if (!isCurrent()) return
      target.sliceStart = performance.now()
    }
    for (const element of model.elements ?? []) {
      for (const [faceName, face] of Object.entries(element.faces)) {
        if (face.texture.startsWith('#')) {
          missingTextures.add(`${modelName} ${faceName}: ${face.texture}`)
          face.texture = 'block/unknown'
        }
      }
    }

    const tileIndex = target.nextTile
    const x = (tileIndex % target.tilesPerRow) * RENDER_SIZE
    const y = Math.floor(tileIndex / target.tilesPerRow) * RENDER_SIZE
    // GL's origin is the bottom left, the atlas image's the top left
    const glY = target.size - y - RENDER_SIZE
    gl.viewport(x, glY, RENDER_SIZE, RENDER_SIZE)
    gl.scissor(x, glY, RENDER_SIZE, RENDER_SIZE)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)

    textureWasRequested = false
    modelData = model
    renderer.setItem(item, { display_context: 'gui' })
    renderer.drawItem()
    // nothing textured was drawn: the tile is cleared and reused by the next icon
    if (!textureWasRequested) continue
    target.tiles[modelName] = { x, y, tileIndex }
    target.nextTile++
  }
  gl.disable(gl.SCISSOR_TEST)

  if (missingTextures.size) {
    console.warn(`[guiRenderer] Missing textures in ${[...missingTextures].join(', ')}`)
  }
}

/**
 * GUI icons of blocks and items that are not plain cubes (rendered with deepslate). All icons go into one WebGL canvas, one 64 px
 * tile each, and the canvas becomes the atlas image with a single read-back. Before, each icon was encoded to a PNG data URL and
 * decoded again: about 7 s on a Mali-G57 phone, while the player was already in the world.
 */
export const generateGuiAtlas = async (appViewer: AppViewer) => {
  const resourcesManager = appViewer.resourcesManager
  const resources = resourcesManager.currentResources
  if (!resources) throw new Error('No resources loaded')
  const resourcesGeneration = resourcesManager.resourcesGeneration
  const isCurrent = () => isCurrentResourceGeneration(resourcesManager, resources, resourcesGeneration)
  const { blockModelsResolved, itemsModelsResolved } = getNonFullBlocksModels(appViewer, resources)

  // upper bound: icons that end up untextured are not kept
  const maxIcons = Object.keys(blockModelsResolved).length + Object.keys(itemsModelsResolved).length
  const tilesPerRow = 2 ** Math.ceil(Math.log2(Math.max(1, Math.ceil(Math.sqrt(maxIcons)))))
  const size = tilesPerRow * RENDER_SIZE
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })
  if (!gl) throw new Error('Cannot get WebGL2 context')
  const target: IconTarget = { gl, size, tilesPerRow, tiles: {}, nextTile: 0, sliceStart: performance.now() }

  try {
    console.time('generate gui atlas')
    await renderIconsIntoAtlas(appViewer, target, blockModelsResolved, false, resources, isCurrent)
    if (!isCurrent()) return
    await renderIconsIntoAtlas(appViewer, target, itemsModelsResolved, true, resources, isCurrent)
    if (!isCurrent()) return
    const image = await createImageBitmap(canvas)
    console.timeEnd('generate gui atlas')

    const textures: Record<string, { u: number; v: number; tileIndex: number }> = {}
    for (const [name, { x, y, tileIndex }] of Object.entries(target.tiles)) {
      // same key rule as mc-assets' makeTextureAtlas (a trailing ".ext" is dropped)
      const cleanName = name.split('.').slice(0, -1).join('.') || name
      textures[cleanName] = { u: x / size, v: y / size, tileIndex }
    }
    const json = { suSv: RENDER_SIZE / size, tileSize: RENDER_SIZE, width: size, height: size, textures }
    publishGuiAtlas(resourcesManager, resources, resourcesGeneration, { json, image })
  } finally {
    loseWebGLContext(gl)
    canvas.remove()
  }
}
