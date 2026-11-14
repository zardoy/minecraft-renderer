import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { BlockEffects, buildTileFlags, swayOriginMod, TILE_FLAG, tileFlagsForTexture, wrapSwayTime } from '../blockEffects'
import { WavingGrassModule } from '../modules/wavingGrass'
import { createCubeBlockMaterial, cubeBlockVertexShader } from '../shaders/cubeBlockShader'
import { createGlobalLegacyBlockMaterial } from '../shaders/legacyBlockShader'
import { defaultWorldRendererConfig } from '../../graphicsBackend/config'

describe('buildTileFlags', () => {
  it('marks the shader cube tile index of leaves and light sources', () => {
    const tile = 16 / 1024
    const flags = buildTileFlags({
      width: 1024,
      height: 1024,
      suSv: tile,
      textures: {
        oak_leaves: { u: 2 * tile, v: tile }, // col 2, row 1
        lava_still: { u: 3 * tile, v: 0 },
        stone: { u: 0, v: 0 }
      }
    })!
    expect(flags.width).toBe(64)
    expect(flags.height).toBe(64)
    const at = (col: number, row: number, channel: number) => flags.data[(row * 64 + col) * 4 + channel]
    expect(at(2, 1, TILE_FLAG.leaves)).toBe(255)
    expect(at(2, 1, TILE_FLAG.emissive)).toBe(0)
    expect(at(3, 0, TILE_FLAG.emissive)).toBe(255)
    expect(at(0, 0, TILE_FLAG.leaves) + at(0, 0, TILE_FLAG.emissive)).toBe(0)
  })

  it('covers every cell of larger textures', () => {
    const flags = buildTileFlags({ width: 64, height: 64, textures: { glowstone: { u: 0, v: 0, su: 0.5, sv: 0.5 } } })!
    expect(flags.data[(1 * 4 + 1) * 4 + TILE_FLAG.emissive]).toBe(255)
    expect(flags.data[(2 * 4 + 2) * 4 + TILE_FLAG.emissive]).toBe(0)
  })

  it('knows light sources by texture name', () => {
    expect(tileFlagsForTexture('torch')).toEqual([TILE_FLAG.emissive])
    expect(tileFlagsForTexture('torch_on')).toEqual([TILE_FLAG.emissive])
    expect(tileFlagsForTexture('fire_0')).toEqual([TILE_FLAG.emissive])
    expect(tileFlagsForTexture('ochre_froglight_side')).toEqual([TILE_FLAG.emissive])
    expect(tileFlagsForTexture('redstone_lamp')).toEqual([])
    expect(tileFlagsForTexture('stone')).toEqual([])
  })
})

describe('sway uniforms', () => {
  it('wraps time and origin into small periodic values', () => {
    expect(wrapSwayTime(1_000_000_000)).toBeCloseTo((1_000_000 % 600) / 1, 6)
    expect(swayOriginMod(-16)).toBe(48)
    expect(swayOriginMod(1_048_576 + 32)).toBe(32)
  })
})

describe('BlockEffects', () => {
  it('compiles the sway code only while enabled, for the right shader family', () => {
    const effects = new BlockEffects()
    const cube = createCubeBlockMaterial()
    const legacy = createGlobalLegacyBlockMaterial()
    effects.register(cube, 'cube')
    effects.register(legacy, 'legacy')
    expect(cube.defines.WAVING_FOLIAGE).toBeUndefined()

    const cubeVersion = cube.version
    effects.setWavingFoliage(true)
    expect(cube.defines).toMatchObject({ WAVING_FOLIAGE: '', WAVING_FOLIAGE_CUBE: '' })
    expect(cube.defines.WAVING_FOLIAGE_LEGACY).toBeUndefined()
    expect(legacy.defines).toMatchObject({ WAVING_FOLIAGE: '', WAVING_FOLIAGE_LEGACY: '' })
    expect(cube.version).toBeGreaterThan(cubeVersion)

    effects.setWavingFoliage(false)
    expect(cube.defines.WAVING_FOLIAGE).toBeUndefined()
    expect(legacy.defines.WAVING_FOLIAGE_LEGACY).toBeUndefined()
  })

  it('applies the current state to materials created later and shares uniform objects', () => {
    const effects = new BlockEffects()
    effects.setWavingFoliage(true)
    const a = createGlobalLegacyBlockMaterial()
    const b = createGlobalLegacyBlockMaterial()
    effects.register(a, 'legacy')
    effects.register(b, 'legacy')
    expect(a.defines.WAVING_FOLIAGE_LEGACY).toBe('')

    effects.setSwayTime(12_345)
    effects.setRenderOrigin({ x: -16, y: 64, z: 80 })
    expect(a.uniforms.u_swayTime).toBe(b.uniforms.u_swayTime)
    expect(b.uniforms.u_swayTime!.value).toBeCloseTo(12.345)
    expect(b.uniforms.u_swayOriginMod!.value).toEqual(new THREE.Vector3(48, 0, 16))
  })

  it('stops touching unregistered materials', () => {
    const effects = new BlockEffects()
    const material = createCubeBlockMaterial()
    effects.register(material, 'cube')
    effects.unregister(material)
    effects.setWavingFoliage(true)
    expect(material.defines.WAVING_FOLIAGE).toBeUndefined()
  })

  it('tile flags texture follows the atlas', () => {
    const effects = new BlockEffects()
    effects.setTileFlagsFromAtlas({ width: 1024, height: 1024, textures: { birch_leaves: { u: 0, v: 0 } } })
    const texture = effects.uniforms.u_tileFlags.value as THREE.DataTexture
    expect(texture.image.width).toBe(64)
    effects.setTileFlagsFromAtlas(undefined)
    expect(effects.uniforms.u_tileFlags.value).toBeNull()
  })

  it('encodes emission only on materials drawn without blending', () => {
    const effects = new BlockEffects()
    const cube = createCubeBlockMaterial()
    const opaque = createGlobalLegacyBlockMaterial()
    const blended = createGlobalLegacyBlockMaterial()
    effects.register(cube, 'cube')
    effects.register(opaque, 'legacy')
    effects.register(blended, 'legacyBlended')
    effects.setBlockEmission(true)
    expect(cube.defines.BLOCK_EMISSION).toBe('')
    expect(opaque.defines.BLOCK_EMISSION).toBe('')
    expect(blended.defines.BLOCK_EMISSION).toBeUndefined()
    effects.setWavingFoliage(true)
    expect(blended.defines.WAVING_FOLIAGE_LEGACY).toBe('')
  })
})

it('cube vertex shader keeps the sway behind its define', () => {
  expect(cubeBlockVertexShader).toContain('#ifdef WAVING_FOLIAGE_CUBE')
  expect(cubeBlockVertexShader).toContain('leafSwayOffset(v_texIndex, relativePos)')
})

describe('WavingGrassModule', () => {
  const createModule = () => {
    const blockEffects = new BlockEffects()
    const worldRenderer = { blockEffects, worldRendererConfig: { ...defaultWorldRendererConfig } }
    return { module: new WavingGrassModule(worldRenderer as any), blockEffects, worldRenderer }
  }

  it('is on by default and follows the option', () => {
    const { module, worldRenderer } = createModule()
    expect(module.autoEnableCheck()).toBe(true)
    worldRenderer.worldRendererConfig.wavingGrass = false
    expect(module.autoEnableCheck()).toBe(false)
  })

  it('enable / disable / dispose switch the shader effect', () => {
    const { module, blockEffects } = createModule()
    module.enable()
    expect(blockEffects.isWavingFoliageEnabled()).toBe(true)
    module.disable()
    expect(blockEffects.isWavingFoliageEnabled()).toBe(false)
    module.enable()
    module.dispose()
    expect(blockEffects.isWavingFoliageEnabled()).toBe(false)
  })
})
