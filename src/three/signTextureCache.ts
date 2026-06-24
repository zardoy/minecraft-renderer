import * as THREE from 'three'
import PrismarineChatLoader from 'prismarine-chat'
import { renderSign } from '../sign-renderer'
import type { WorldRendererThree } from './worldRendererThree'

const signTextureCache = new Map<string, { texture: THREE.Texture; refCount: number }>()

// Build the key ONLY from fields that change rendered pixels, so two signs
// with identical visible text share a texture even if other NBT differs.
function createSignCacheKey(blockEntity: any, isHanging: boolean, backSide: boolean): string {
  let lines: string[]
  let color: string
  if (blockEntity && 'front_text' in blockEntity) {
    // 1.20+
    lines = blockEntity.front_text?.messages ?? []
    color = blockEntity.front_text?.color || 'black'
  } else {
    // legacy
    lines = [blockEntity?.Text1, blockEntity?.Text2, blockEntity?.Text3, blockEntity?.Text4]
    color = blockEntity?.Color || 'black'
  }
  // \0 separator: cannot appear in JSON text components, so no key collisions
  return `${isHanging ? 1 : 0}|${backSide ? 1 : 0}|${color}|${lines.join('\0')}`
}

export function getSignTexture(worldRenderer: WorldRendererThree, blockEntity: any, isHanging: boolean, backSide = false): THREE.Texture | undefined {
  const cacheKey = createSignCacheKey(blockEntity, isHanging, backSide)
  const cached = signTextureCache.get(cacheKey)
  if (cached) {
    cached.refCount++
    return cached.texture
  }
  const PrismarineChat = PrismarineChatLoader(worldRenderer.version)
  const canvas = renderSign(blockEntity, isHanging, PrismarineChat)
  if (!canvas) return undefined
  const tex = new THREE.Texture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.needsUpdate = true
  signTextureCache.set(cacheKey, { texture: tex, refCount: 1 })
  return tex
}

export function releaseSignTexture(texture: THREE.Texture): void {
  for (const [key, cached] of signTextureCache.entries()) {
    if (cached.texture === texture) {
      cached.refCount--
      if (cached.refCount <= 0) {
        cached.texture.dispose()
        signTextureCache.delete(key)
      }
      return
    }
  }
}

export function disposeAllSignTextures(): void {
  for (const [, cached] of signTextureCache) cached.texture.dispose()
  signTextureCache.clear()
}
