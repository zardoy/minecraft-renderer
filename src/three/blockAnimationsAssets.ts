import blocksAnimations from 'mc-assets/dist/blocksAnimations.json'
import blocksAnimationsAtlas from 'mc-assets/dist/blocksAnimationsAtlas.png'
import type { TextureAnimationsJson } from 'mc-assets/dist/textureAnimations'
import { loadImageFromUrl } from '../lib/utils'

export type BlockAnimationAssets = { animations: TextureAnimationsJson; framesImage: ImageBitmap }

let assets: Promise<BlockAnimationAssets> | undefined

/**
 * Static data of mc-assets, loaded once. Main thread only: the three worker bundle stubs mc-assets json/png imports
 * (they are empty there), so the worker gets this through `LoadedResourcesTransferrable.blockAnimationAssets`.
 */
export const loadBlockAnimationAssets = () => {
  assets ??= loadImageFromUrl(blocksAnimationsAtlas).then(framesImage => ({ animations: blocksAnimations as unknown as TextureAnimationsJson, framesImage }))
  assets.catch(() => (assets = undefined))
  return assets
}
