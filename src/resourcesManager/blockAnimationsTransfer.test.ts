import { describe, expect, it, vi } from 'vitest'
import { LoadedResourcesTransferrable } from './resourcesManager'

vi.mock('../three/documentRenderer', () => ({
  isWebWorker: true
}))

describe('animated block textures data transfer', () => {
  // the three worker bundle stubs mc-assets json/png imports, so everything it needs has to travel with the resources
  it('is part of the snapshot sent to the renderer worker', () => {
    const resources = new LoadedResourcesTransferrable()
    const assets = { animations: { image: { width: 1, height: 1 }, latest: {}, versions: {} }, framesImage: {} as ImageBitmap }
    resources.blockAnimationAssets = assets
    resources.replacedBlockTextures = ['water_still']

    const transferred = resources.prepareForTransfer()
    expect(transferred.blockAnimationAssets).toBe(assets)
    expect(transferred.replacedBlockTextures).toEqual(['water_still'])
    // customTextures are dropped from the snapshot, that's why replaced names are kept separately
    expect(transferred.customTextures).toEqual({})
  })
})
