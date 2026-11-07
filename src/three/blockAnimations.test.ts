import { describe, expect, test, vi } from 'vitest'
import * as THREE from 'three'
import { parseAnimationMcmeta, TextureAnimationsJson, AtlasTextureAnimation } from 'mc-assets/dist/textureAnimations'
import { AnimatedBlockTextures, AnimatedEntry, SMOOTH_STEPS, blendFrames, getAnimationFrameToShow, planBlockAnimations } from './blockAnimations'

const animation = (mcmeta: object, height: number): AtlasTextureAnimation => ({ ...parseAnimationMcmeta({ animation: mcmeta }, 16, height)!, x: 0, y: 0 })

describe('planBlockAnimations', () => {
  const animations: TextureAnimationsJson = {
    image: { width: 16, height: 128 },
    latest: { water_still: animation({ frametime: 2 }, 64), fire: animation({}, 64), not_in_atlas: animation({}, 32) },
    versions: { '1.14': { water_still: null } }
  }
  const atlas = {
    width: 256,
    height: 256,
    suSv: 16 / 256,
    textures: { stone: { u: 0, v: 0 }, water_still: { u: 32 / 256, v: 16 / 256 }, fire: { u: 0.5, v: 0.5, su: 32 / 256, sv: 32 / 256 } }
  }

  test('only animated textures present in the atlas, with their position', () => {
    const planned = planBlockAnimations(animations, atlas, 'latest')
    expect(planned.map(p => p.name).sort()).toEqual(['fire', 'water_still'])
    expect(planned.find(p => p.name === 'water_still')!.dst).toEqual({ x: 32, y: 16, width: 16, height: 16 })
    // custom slot size
    expect(planned.find(p => p.name === 'fire')!.dst).toEqual({ x: 128, y: 128, width: 32, height: 32 })
  })

  test('respects version and skip', () => {
    expect(planBlockAnimations(animations, atlas, '1.13').map(p => p.name)).toEqual(['fire'])
    expect(planBlockAnimations(animations, atlas, 'latest', name => name === 'fire').map(p => p.name)).toEqual(['water_still'])
  })
})

describe('getAnimationFrameToShow', () => {
  const plain = animation({ frametime: 2, frames: [0, 1, 0, 2] }, 48)
  const interpolated = animation({ frametime: 8, interpolate: true }, 48)

  test('same visible frame has the same key (nothing to upload)', () => {
    // frames 0,1,0,2 each shown for 2 ticks: the first and third entry are the same picture
    const key = (tick: number) => getAnimationFrameToShow(plain, tick, true).key
    expect(key(0)).toBe(key(1))
    expect(key(0)).toBe(key(4))
    expect(new Set([0, 2, 4, 6].map(key)).size).toBe(3)
  })

  test('blends only in smooth mode and only if animation asks for it', () => {
    expect(getAnimationFrameToShow(interpolated, 5, true).blend).toBe(Math.floor((5 / 8) * SMOOTH_STEPS))
    expect(getAnimationFrameToShow(interpolated, 5, false).blend).toBe(0)
    expect(getAnimationFrameToShow(plain, 1, true).blend).toBe(0)
  })

  test('interpolation is quantized: at most SMOOTH_STEPS uploads per frame', () => {
    const keys = new Set(Array.from({ length: 8 }, (_, tick) => getAnimationFrameToShow(interpolated, tick, true).key))
    expect(keys.size).toBe(SMOOTH_STEPS)
  })

  test('key is never 0, so 0 can mean "not shown yet"', () => {
    for (let tick = 0; tick < 24; tick++) expect(getAnimationFrameToShow(interpolated, tick, true).key).not.toBe(0)
  })
})

test('blendFrames', () => {
  const a = new Uint8Array([0, 100, 255, 255])
  const b = new Uint8Array([100, 100, 0, 255])
  const out = new Uint8Array(4)
  blendFrames(a, 0, b, 0, 2, out)
  expect([...out]).toEqual([50, 100, 128, 255])
  // offsets
  blendFrames(new Uint8Array([9, 9, 0, 0, 0, 0]), 2, new Uint8Array([7, 8, 100, 100, 100, 100]), 2, 1, out)
  expect([...out]).toEqual([25, 25, 25, 25])
})

describe('AnimatedBlockTextures.update', () => {
  // frames of 16x16: frame i is filled with value i * 10
  const makeEntry = (name: string, mcmeta: object, frameCount: number, dstX: number): AnimatedEntry => {
    const data = new Uint8Array(16 * 16 * 4 * frameCount)
    for (let i = 0; i < frameCount; i++) data.fill(i * 10, i * 1024, (i + 1) * 1024)
    return {
      name,
      animation: animation(mcmeta, 16 * frameCount),
      dst: { x: dstX, y: 0, width: 16, height: 16 },
      frames: new THREE.DataTexture(data, 16, 16 * frameCount),
      lastKey: 0
    }
  }
  type Call = { src: THREE.Texture; region: number[] | null; x: number; firstPixel: number }
  const setup = () => {
    const atlas = new THREE.Texture()
    atlas.needsUpdate = true
    const entries = [
      makeEntry('slow', { frametime: 10 }, 4, 0),
      makeEntry('fast', { frametime: 1 }, 4, 16),
      makeEntry('blend', { frametime: 8, interpolate: true }, 4, 32)
    ]
    // the position and region objects are reused between calls (real GL consumes them right away), so snapshot them
    const calls: Call[] = []
    const renderer = {
      copyTextureToTexture: (src: THREE.DataTexture, _dst: THREE.Texture, region: THREE.Box2 | null, pos: THREE.Vector2) => {
        calls.push({
          src,
          region: region && [...region.min.toArray(), ...region.max.toArray()],
          x: pos.x,
          firstPixel: (src.image.data as Uint8Array)[region ? region.min.y * 64 : 0]!
        })
      }
    } as unknown as THREE.WebGLRenderer
    return { atlas, animated: new AnimatedBlockTextures(atlas, entries), calls, renderer }
  }
  const tickMs = (tick: number) => tick * 50 + 10
  const copiedDst = (calls: Call[]) => calls.map(call => call.x)

  test('first update writes everything, then only what changed', () => {
    const { animated, calls, renderer } = setup()
    animated.update(renderer, tickMs(100), 'basic')
    expect(copiedDst(calls)).toEqual([0, 16, 32])

    calls.length = 0
    // same tick, many render frames: nothing
    animated.update(renderer, tickMs(100) + 20, 'basic')
    animated.update(renderer, tickMs(100) + 30, 'basic')
    expect(calls).toHaveLength(0)

    // next tick: only the 1-tick animation, basic mode doesn't blend
    animated.update(renderer, tickMs(101), 'basic')
    expect(copiedDst(calls)).toEqual([16])
  })

  test('copies the right frame region', () => {
    const { animated, calls, renderer } = setup()
    animated.update(renderer, tickMs(2), 'basic')
    // fast animation at tick 2 shows frame 2 (16px high frames), filled with 20
    const fast = calls.find(call => call.x === 16)!
    expect(fast.region).toEqual([0, 32, 16, 48])
    expect(fast.firstPixel).toBe(20)
    expect(fast.src).toBeInstanceOf(THREE.Texture)
  })

  test('smooth mode blends interpolated animations with a CPU scratch texture', () => {
    const { animated, calls, renderer } = setup()
    // tick 4 of 8: halfway between frame 0 (0) and frame 1 (10)
    animated.update(renderer, tickMs(4), 'smooth')
    const blended = calls.find(call => call.x === 32)!
    expect(blended.region).toBeNull()
    expect(blended.firstPixel).toBe(5)
    expect((blended.src as THREE.DataTexture).image.data).toHaveLength(1024)

    calls.length = 0
    animated.update(renderer, tickMs(5), 'smooth')
    // 5/8 is still in the same quarter-step as 4/8 (2 of 4)
    expect(copiedDst(calls)).not.toContain(32)
    animated.update(renderer, tickMs(6), 'smooth')
    expect(copiedDst(calls)).toContain(32)
  })

  test('writes everything again when the atlas texture is re-uploaded', () => {
    const { animated, atlas, calls, renderer } = setup()
    animated.update(renderer, tickMs(100), 'basic')
    calls.length = 0
    atlas.needsUpdate = true
    animated.update(renderer, tickMs(100), 'basic')
    expect(copiedDst(calls)).toEqual([0, 16, 32])
  })

  test('off mode restores first frames once and then does nothing', () => {
    const { animated, atlas, calls, renderer } = setup()
    animated.update(renderer, tickMs(100), 'basic')
    calls.length = 0
    const version = atlas.version
    animated.update(renderer, tickMs(101), 'off')
    expect(atlas.version).toBe(version + 1)
    animated.update(renderer, tickMs(102), 'off')
    expect(atlas.version).toBe(version + 1)
    expect(calls).toHaveLength(0)
    // enabling again writes everything
    animated.update(renderer, tickMs(103), 'basic')
    expect(copiedDst(calls)).toEqual([0, 16, 32])
  })
})
