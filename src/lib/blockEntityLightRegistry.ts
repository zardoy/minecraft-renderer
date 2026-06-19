import * as THREE from 'three'
import {
  blockEntityBrightness,
  DEFAULT_LIGHTMAP_PARAMS,
  type BlockLightmapParams,
} from './blockEntityLighting'

export type BlockEntityOverlayLight = {
  material: THREE.MeshBasicMaterial
  blockLightNorm: number
  skyLightNorm: number
}

export class BlockEntityLightRegistry {
  private readonly entries = new Set<BlockEntityOverlayLight>()
  private skyLevel = 1
  private lightmapParams: BlockLightmapParams = { ...DEFAULT_LIGHTMAP_PARAMS }

  register (entry: BlockEntityOverlayLight): void {
    this.entries.add(entry)
    this.applyBrightness(entry)
  }

  unregister (material: THREE.Material): void {
    for (const entry of this.entries) {
      if (entry.material === material) {
        this.entries.delete(entry)
        break
      }
    }
  }

  setSkyLevel (value: number): void {
    this.skyLevel = value
    this.refreshAll()
  }

  setLightmapParams (params: BlockLightmapParams): void {
    this.lightmapParams = { ...this.lightmapParams, ...params }
    this.refreshAll()
  }

  getSkyLevel (): number {
    return this.skyLevel
  }

  private refreshAll (): void {
    for (const entry of this.entries) {
      this.applyBrightness(entry)
    }
  }

  private applyBrightness (entry: BlockEntityOverlayLight): void {
    const brightness = blockEntityBrightness(
      entry.blockLightNorm,
      entry.skyLightNorm,
      this.skyLevel,
      this.lightmapParams,
    )
    entry.material.color.setScalar(brightness)
  }
}

export function tintBannerMaterial (
  material: THREE.MeshBasicMaterial,
  blockLightNorm: number,
  skyLightNorm: number,
  skyLevel: number,
  lightmapParams: BlockLightmapParams = DEFAULT_LIGHTMAP_PARAMS,
): number {
  const brightness = blockEntityBrightness(blockLightNorm, skyLightNorm, skyLevel, lightmapParams)
  material.color.setScalar(brightness)
  return brightness
}
