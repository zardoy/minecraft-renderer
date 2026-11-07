import type { WorldRendererThree } from '../worldRendererThree'
import type { RendererModuleController, RendererModuleManifest } from '../rendererModuleSystem'

/**
 * Grass, flowers, saplings, crops (legacy geometry, tagged by the mesher) and leaves (shader cubes) sway in the wind.
 * Pure vertex shader work: enabling it adds a define to the block materials (one recompile), disabled it costs nothing.
 */
export class WavingFoliageModule implements RendererModuleController {
  private enabled = false

  constructor(private readonly worldRenderer: WorldRendererThree) {}

  enable(): void {
    if (this.enabled) return
    this.enabled = true
    this.worldRenderer.blockEffects.setWavingFoliage(true)
  }

  disable(): void {
    if (!this.enabled) return
    this.enabled = false
    this.worldRenderer.blockEffects.setWavingFoliage(false)
  }

  autoEnableCheck(): boolean {
    return this.worldRenderer.worldRendererConfig.wavingFoliage
  }

  // Runs after the frame is drawn, the time is one frame behind which is not noticeable.
  render = (): void => {
    this.worldRenderer.blockEffects.setSwayTime(performance.now())
  }

  dispose(): void {
    this.disable()
  }
}

export const wavingFoliageManifest: RendererModuleManifest = {
  id: 'wavingFoliage',
  controller: WavingFoliageModule
}
