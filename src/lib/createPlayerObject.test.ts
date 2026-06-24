import { describe, expect, it, vi } from 'vitest'

vi.mock('./utils/skins', () => ({
  stevePngUrl: '',
  loadSkinImage: vi.fn()
}))

import { PlayerObject } from 'skinview3d'
import { configurePlayerSkinMaterials } from './createPlayerObject'

describe('configurePlayerSkinMaterials', () => {
  it('configures cutout materials and log-depth bias on arm/leg mats only', () => {
    const playerObject = new PlayerObject()
    const skin = playerObject.skin as any

    configurePlayerSkinMaterials(playerObject)

    const allMaterials = [skin.layer1Material, skin.layer1MaterialBiased, skin.layer2Material, skin.layer2MaterialBiased]
    for (const mat of allMaterials) {
      expect(mat.transparent).toBe(false)
      expect(mat.alphaTest).toBe(0.1)
      expect(mat.depthWrite).toBe(true)
    }

    expect(skin.layer1MaterialBiased.userData.logDepthBiasApplied).toBe(true)
    expect(skin.layer2MaterialBiased.userData.logDepthBiasApplied).toBe(true)
    expect(typeof skin.layer1MaterialBiased.onBeforeCompile).toBe('function')
    expect(typeof skin.layer2MaterialBiased.onBeforeCompile).toBe('function')
    expect(skin.layer1MaterialBiased.onBeforeCompile).toBe(skin.layer2MaterialBiased.onBeforeCompile)

    expect(skin.layer1Material.userData.logDepthBiasApplied).toBeUndefined()
    expect(skin.layer2Material.userData.logDepthBiasApplied).toBeUndefined()
    expect(skin.layer1Material.onBeforeCompile).not.toBe(skin.layer1MaterialBiased.onBeforeCompile)
    expect(skin.layer2Material.onBeforeCompile).not.toBe(skin.layer2MaterialBiased.onBeforeCompile)

    const firstCompile = skin.layer1MaterialBiased.onBeforeCompile
    configurePlayerSkinMaterials(playerObject)
    expect(skin.layer1MaterialBiased.onBeforeCompile).toBe(firstCompile)
  })
})
