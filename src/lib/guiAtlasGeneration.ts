export type ResourceGenerationState<T> = {
  currentResources?: T
  resourcesGeneration: number
}

export const isCurrentResourceGeneration = <T>(manager: ResourceGenerationState<T>, resources: T, generation: number): boolean =>
  manager.currentResources === resources && manager.resourcesGeneration === generation

export type GuiAtlas = {
  json: any
  image: ImageBitmap
}

export type GuiAtlasResources = {
  guiAtlas: GuiAtlas | null
  guiAtlasVersion: number
}

export const publishGuiAtlas = <T extends GuiAtlasResources>(
  manager: ResourceGenerationState<T>,
  resources: T,
  generation: number,
  guiAtlas: GuiAtlas
): boolean => {
  if (!isCurrentResourceGeneration(manager, resources, generation)) return false
  resources.guiAtlas = guiAtlas
  resources.guiAtlasVersion++
  return true
}
