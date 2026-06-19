import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { blockEntityBrightness } from './blockEntityLighting'
import { BlockEntityLightRegistry } from './blockEntityLightRegistry'

describe('BlockEntityLightRegistry', () => {
  it('refreshes overlay brightness when sky level changes', () => {
    const registry = new BlockEntityLightRegistry()
    const material = new THREE.MeshBasicMaterial()
    registry.register({ material, blockLightNorm: 0, skyLightNorm: 1 })
    const nightSky = 4 / 15
    registry.setSkyLevel(nightSky)
    expect(material.color.r).toBeCloseTo(blockEntityBrightness(0, 1, nightSky), 5)
    registry.setSkyLevel(1)
    expect(material.color.r).toBe(1)
  })
})
