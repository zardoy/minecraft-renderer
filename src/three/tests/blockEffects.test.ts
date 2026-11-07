import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { BlockEffects, buildLeafTileMask, swayOriginMod, wrapSwayTime } from '../blockEffects'
import { WavingFoliageModule } from '../modules/wavingFoliage'
import { createCubeBlockMaterial, cubeBlockVertexShader } from '../shaders/cubeBlockShader'
import { createGlobalLegacyBlockMaterial } from '../shaders/legacyBlockShader'
import { defaultWorldRendererConfig } from '../../graphicsBackend/config'

describe('buildLeafTileMask', () => {
  it('marks the shader cube tile index of every leaves texture', () => {
    const mask = buildLeafTileMask({
      width: 1024,
      height: 1024,
      textures: {
        oak_leaves: { u: 32 / 1024, v: 16 / 1024 }, // col 2, row 1
        stone: { u: 0, v: 0 }
      }
    })!
    expect(mask.width).toBe(64)
    expect(mask.height).toBe(64)
    expect(mask.data[1 * 64 + 2]).toBe(255)
    expect(mask.data[0]).toBe(0)
    expect(mask.data.reduce((a, b) => a + (b ? 1 : 0), 0)).toBe(1)
  })

  it('gives up on atlases that cannot use the shader cube layout', () => {
    expect(buildLeafTileMask({ width: 4096, height: 4096, textures: {} })).toBeUndefined()
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

  it('leaf mask texture follows the atlas', () => {
    const effects = new BlockEffects()
    effects.setLeafMaskFromAtlas({ width: 1024, height: 1024, textures: { birch_leaves: { u: 0, v: 0 } } })
    const texture = effects.uniforms.u_leafMask.value as THREE.DataTexture
    expect(texture.image.width).toBe(64)
    effects.setLeafMaskFromAtlas(undefined)
    expect(effects.uniforms.u_leafMask.value).toBeNull()
  })
})

it('cube vertex shader keeps the sway behind its define', () => {
  expect(cubeBlockVertexShader).toContain('#ifdef WAVING_FOLIAGE_CUBE')
  expect(cubeBlockVertexShader).toContain('leafSwayOffset(v_texIndex, relativePos)')
})

describe('WavingFoliageModule', () => {
  const createModule = () => {
    const blockEffects = new BlockEffects()
    const worldRenderer = { blockEffects, worldRendererConfig: { ...defaultWorldRendererConfig } }
    return { module: new WavingFoliageModule(worldRenderer as any), blockEffects, worldRenderer }
  }

  it('is off by default and follows the option', () => {
    const { module, worldRenderer } = createModule()
    expect(module.autoEnableCheck()).toBe(false)
    worldRenderer.worldRendererConfig.wavingFoliage = true
    expect(module.autoEnableCheck()).toBe(true)
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
