import * as THREE from 'three'
import { AtlasTextureAnimation, TextureAnimationsJson, getAnimationFrameRect, getAnimationStateAt, getTextureAnimation } from 'mc-assets/dist/textureAnimations'
import { createCanvas } from '../lib/utils'

/**
 * Animated block textures (water, lava, fire, portals, command blocks...).
 *
 * The blocks atlas contains the first frame of every animated texture. Like vanilla, we play the animation by copying
 * the current frame over the texture slot in the atlas, so meshes (UVs) never change and nothing is remeshed.
 *
 * Why it is cheap:
 * - work happens only when a game tick (50ms) passes, and a texture is uploaded only when its frame actually changed
 * - one upload is a 16x16 (1KB) texSubImage2D from CPU memory, the atlas is never re-uploaded
 * - requires `generateMipmaps = false` on the atlas, otherwise three regenerates all mipmaps of the whole atlas on every copy
 */

/** `basic` switches frames, `smooth` also blends frames of `interpolate` animations (like vanilla) */
export type AnimatedTexturesMode = 'off' | 'basic' | 'smooth'

const TICK_MS = 50
/** Vanilla blends interpolated animations every tick, we do at most this many steps per frame transition: not noticeable, but 2-3x fewer uploads */
export const SMOOTH_STEPS = 4

type AtlasJson = {
  width: number
  height: number
  suSv: number
  textures: Record<string, { u: number; v: number; su?: number; sv?: number }>
}

export type PlannedAnimation = {
  name: string
  animation: AtlasTextureAnimation
  /** where the texture is in the atlas, in pixels */
  dst: { x: number; y: number; width: number; height: number }
}

/**
 * Finds what should be animated in the given atlas.
 * @param skip textures that are not vanilla (replaced by resource pack, etc.), their animation data doesn't apply
 */
export const planBlockAnimations = (
  animations: TextureAnimationsJson,
  atlas: AtlasJson,
  version: string,
  skip?: (name: string) => boolean
): PlannedAnimation[] => {
  const names = new Set([...Object.keys(animations.latest), ...Object.values(animations.versions).flatMap(textures => Object.keys(textures))])
  const planned: PlannedAnimation[] = []
  for (const name of names) {
    const info = atlas.textures[name]
    if (!info || skip?.(name)) continue
    const animation = getTextureAnimation(animations, name, version)
    if (!animation) continue
    planned.push({
      name,
      animation,
      dst: {
        x: Math.round(info.u * atlas.width),
        y: Math.round(info.v * atlas.height),
        width: Math.round((info.su ?? atlas.suSv) * atlas.width),
        height: Math.round((info.sv ?? atlas.suSv) * atlas.height)
      }
    })
  }
  return planned
}

/**
 * What should be displayed at the given tick.
 * `key` identifies the visible result: when it didn't change since the last update, there is nothing to upload.
 */
export const getAnimationFrameToShow = (animation: AtlasTextureAnimation, tick: number, smooth: boolean) => {
  const { frameIndex, nextFrameIndex, progress } = getAnimationStateAt(animation, tick)
  const blend = smooth && animation.interpolate ? Math.floor(progress * SMOOTH_STEPS) : 0
  return {
    frameIndex,
    nextFrameIndex,
    /** 0..SMOOTH_STEPS-1: how much of the next frame is mixed in */
    blend,
    // plain frames are negative and blended ones positive, so 0 is free to mean "nothing shown yet"
    key: blend ? (frameIndex * animation.frameCount + nextFrameIndex) * SMOOTH_STEPS + blend : -(frameIndex + 1)
  }
}

export const blendFrames = (a: Uint8Array, aOffset: number, b: Uint8Array, bOffset: number, blend: number, out: Uint8Array) => {
  const factor = blend / SMOOTH_STEPS
  for (let i = 0; i < out.length; i++) {
    const from = a[aOffset + i]!
    out[i] = from + (b[bOffset + i]! - from) * factor + 0.5
  }
}

export type AnimatedEntry = PlannedAnimation & {
  /** all frames of the animation scaled to the atlas slot size, stacked vertically. Never uploaded to GPU as is */
  frames: THREE.DataTexture
  lastKey: number
}

const srcRegion = new THREE.Box2()
const dstPosition = new THREE.Vector2()

export class AnimatedBlockTextures {
  private lastTick = NaN
  /** atlas texture version we have written frames to, if the atlas gets re-uploaded we need to write them again */
  private syncedAtlasVersion = NaN
  private applied = false
  private readonly scratch = new Map<string, THREE.DataTexture>()

  constructor(
    private readonly atlasTexture: THREE.Texture,
    private readonly entries: AnimatedEntry[]
  ) {}

  get animatedCount() {
    return this.entries.length
  }

  /** Call every frame before rendering, it is cheap when nothing changed */
  update(renderer: THREE.WebGLRenderer, nowMs: number, mode: AnimatedTexturesMode) {
    if (mode === 'off') {
      if (this.applied) this.restoreFirstFrames()
      return
    }
    const tick = Math.floor(nowMs / TICK_MS)
    const atlasChanged = this.atlasTexture.version !== this.syncedAtlasVersion
    if (tick === this.lastTick && !atlasChanged) return
    this.lastTick = tick
    this.syncedAtlasVersion = this.atlasTexture.version
    this.applied = true

    const smooth = mode === 'smooth'
    for (const entry of this.entries) {
      const { frameIndex, nextFrameIndex, blend, key } = getAnimationFrameToShow(entry.animation, tick, smooth)
      if (key === entry.lastKey && !atlasChanged) continue
      entry.lastKey = key
      const { x, y, width, height } = entry.dst
      dstPosition.set(x, y)
      if (blend) {
        const scratch = this.getScratch(width, height)
        const data = entry.frames.image.data as Uint8Array
        const frameSize = width * height * 4
        blendFrames(data, frameIndex * frameSize, data, nextFrameIndex * frameSize, blend, scratch.image.data as Uint8Array)
        renderer.copyTextureToTexture(scratch, this.atlasTexture, null, dstPosition)
      } else {
        srcRegion.min.set(0, frameIndex * height)
        srcRegion.max.set(width, (frameIndex + 1) * height)
        renderer.copyTextureToTexture(entry.frames, this.atlasTexture, srcRegion, dstPosition)
      }
    }
  }

  /** The atlas image still contains first frames, just upload it again */
  private restoreFirstFrames() {
    this.atlasTexture.needsUpdate = true
    this.applied = false
    this.syncedAtlasVersion = NaN
    for (const entry of this.entries) entry.lastKey = 0
  }

  private getScratch(width: number, height: number) {
    const key = `${width}x${height}`
    let texture = this.scratch.get(key)
    if (!texture) {
      texture = new THREE.DataTexture(new Uint8Array(width * height * 4), width, height)
      this.scratch.set(key, texture)
    }
    return texture
  }

  dispose() {
    for (const entry of this.entries) entry.frames.dispose()
    for (const texture of this.scratch.values()) texture.dispose()
    this.scratch.clear()
  }
}

/** Scales every frame of the animation to the slot size the texture has in the atlas (e.g. 32x32 frames of water_flow into 16x16) */
const makeFramesTexture = (image: ImageBitmap, { animation, dst }: PlannedAnimation) => {
  const canvas = createCanvas(dst.width, dst.height * animation.frameCount)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingEnabled = false
  for (let i = 0; i < animation.frameCount; i++) {
    const rect = getAnimationFrameRect(animation, i)
    ctx.drawImage(image, animation.x + rect.x, animation.y + rect.y, rect.width, rect.height, 0, i * dst.height, dst.width, dst.height)
  }
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return new THREE.DataTexture(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), canvas.width, canvas.height)
}

export const createAnimatedBlockTextures = (options: {
  atlasTexture: THREE.Texture
  atlasJson: AtlasJson
  /** textures version of the atlas */
  version: string
  animations: TextureAnimationsJson
  /** `blocksAnimationsAtlas.png` */
  framesImage: ImageBitmap
  skip?: (name: string) => boolean
}) => {
  const planned = planBlockAnimations(options.animations, options.atlasJson, options.version, options.skip)
  const entries = planned.map((plan): AnimatedEntry => ({ ...plan, frames: makeFramesTexture(options.framesImage, plan), lastKey: 0 }))
  return new AnimatedBlockTextures(options.atlasTexture, entries)
}
