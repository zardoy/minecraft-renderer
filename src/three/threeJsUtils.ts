import * as THREE from 'three'
import { getLoadedImage } from 'mc-assets/dist/utils'
import { createCanvas, loadImageFromUrl } from '../lib/utils'

export const disposeObject = (obj: THREE.Object3D, cleanTextures = false) => {
  // not cleaning texture there as it might be used by other objects, but would be good to also do that
  if (obj instanceof THREE.Mesh) {
    obj.geometry?.dispose?.()
    obj.material?.dispose?.()
  }
  if (obj.children) {
    // eslint-disable-next-line unicorn/no-array-for-each
    obj.children.forEach(child => disposeObject(child, cleanTextures))
  }
  if (cleanTextures) {
    if (obj instanceof THREE.Mesh) {
      obj.material?.map?.dispose?.()
    }
  }
}

let textureCache: Record<string, THREE.Texture> = {}
let imagesPromises: Record<string, Promise<THREE.Texture>> = {}

export const loadThreeJsTextureFromUrlSync = (imageUrl: string) => {
  const texture = new THREE.Texture()
  const promise = loadImageFromUrl(imageUrl).then(bitmap => {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    texture.source.data = canvas
    texture.needsUpdate = true
    return texture
  })
  return {
    texture,
    promise
  }

  // MAIN
  // const texture = new THREE.Texture()
  // const promise = getLoadedImage(imageUrl).then(image => {
  //   texture.image = image
  //   texture.needsUpdate = true
  //   return texture
  // })
  // return {
  //   texture,
  //   promise
  // }
}

export const loadThreeJsTextureFromUrl = async (imageUrl: string) => {
  return loadThreeJsTextureFromUrlSync(imageUrl).texture

  // MAIN
  // const loaded = new THREE.TextureLoader().loadAsync(imageUrl)
  // return loaded
}

export const loadThreeJsTextureFromBitmap = (image: ImageBitmap) => {
  const canvas = createCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(image, 0, 0)
  const texture = new THREE.Texture(canvas)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  return texture
}

/** Worker-safe sync handle; image loads via fetch + OffscreenCanvas (not TextureLoader). */
export function loadNearestFilterTexture(imageUrl: string): THREE.Texture {
  const { texture, promise } = loadThreeJsTextureFromUrlSync(imageUrl)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  void promise.catch(err => {
    console.error('[texture] failed to load', imageUrl, err)
  })
  return texture
}

export async function loadTexture(texture: string, cb: (texture: THREE.Texture) => void, onLoad?: () => void): Promise<void> {
  const cached = textureCache[texture]
  if (!cached) {
    const { promise, resolve } = Promise.withResolvers<THREE.Texture>()
    const t = loadThreeJsTextureFromUrlSync(texture)
    textureCache[texture] = t.texture
    void t.promise.then(resolve)
    imagesPromises[texture] = promise
  }

  cb(textureCache[texture])
  void imagesPromises[texture].then(() => {
    onLoad?.()
  })
}

export const clearTextureCache = () => {
  textureCache = {}
  imagesPromises = {}
}
