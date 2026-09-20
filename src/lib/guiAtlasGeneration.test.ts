import { expect, test } from 'vitest'
import { isCurrentResourceGeneration, publishGuiAtlas, type GuiAtlas } from './guiAtlasGeneration'

test('rejects publication from an older resource generation', () => {
  const firstResources = {}
  const secondResources = {}
  const manager = {
    currentResources: firstResources,
    resourcesGeneration: 1
  }

  expect(isCurrentResourceGeneration(manager, firstResources, 1)).toBe(true)

  manager.currentResources = secondResources
  manager.resourcesGeneration = 2

  expect(isCurrentResourceGeneration(manager, firstResources, 1)).toBe(false)
  expect(isCurrentResourceGeneration(manager, secondResources, 2)).toBe(true)
})

test('publishes GUI atlas only for the current resource generation', () => {
  const firstResources = { guiAtlas: null as GuiAtlas | null, guiAtlasVersion: 3 }
  const secondResources = { guiAtlas: null as GuiAtlas | null, guiAtlasVersion: 7 }
  const manager = {
    currentResources: firstResources,
    resourcesGeneration: 1
  }
  const atlas = { json: {}, image: {} as ImageBitmap }

  expect(publishGuiAtlas(manager, firstResources, 0, atlas)).toBe(false)
  expect(firstResources.guiAtlas).toBeNull()
  expect(firstResources.guiAtlasVersion).toBe(3)

  manager.currentResources = secondResources
  manager.resourcesGeneration = 2

  expect(publishGuiAtlas(manager, secondResources, 2, atlas)).toBe(true)
  expect(secondResources.guiAtlas).toBe(atlas)
  expect(secondResources.guiAtlasVersion).toBe(8)
})
