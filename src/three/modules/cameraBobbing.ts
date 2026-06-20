import type { WorldRendererThree } from '../worldRendererThree'
import type { RendererModuleController, RendererModuleManifest } from '../rendererModuleSystem'

export class CameraBobbingModule implements RendererModuleController {
  private enabled = false
  private lastBobWalkDist = 0
  private lastBobTickTime = 0

  constructor(private readonly worldRenderer: WorldRendererThree) {}

  enable(): void {
    this.enabled = true
  }

  disable(): void {
    this.enabled = false
    this.worldRenderer.cameraShake.setCameraBobInput(null)
    const { perspective } = this.worldRenderer.playerStateReactive
    if (perspective === 'first_person') {
      this.worldRenderer.camera.position.set(0, 0, 0)
    }
  }

  render?: (deltaTime: number) => void = () => {
    if (!this.enabled) return
    const config = this.worldRenderer.displayOptions.inWorldRenderingConfig
    const { perspective } = this.worldRenderer.playerStateReactive
    // Spectator (gm3) flies through blocks and does not "walk" — view bobbing
    // there only makes the camera feel jittery/unstable. Keep it gated even
    // when the user has `viewBobbing` enabled in settings.
    const shouldBobCamera = config.viewBobbing && perspective === 'first_person' && !this.worldRenderer.playerStateUtils.isSpectator()

    if (shouldBobCamera) {
      if (this.worldRenderer.playerStateReactive.walkDist !== this.lastBobWalkDist) {
        this.lastBobTickTime = performance.now()
        this.lastBobWalkDist = this.worldRenderer.playerStateReactive.walkDist
      }
      const partialTick = Math.min((performance.now() - this.lastBobTickTime) / 50, 1)

      this.worldRenderer.cameraShake.setCameraBobInput({
        walkDist: this.worldRenderer.playerStateReactive.walkDist,
        prevWalkDist: this.worldRenderer.playerStateReactive.prevWalkDist,
        bob: this.worldRenderer.playerStateReactive.bob,
        prevBob: this.worldRenderer.playerStateReactive.prevBob,
        partialTick
      })
    } else {
      this.worldRenderer.cameraShake.setCameraBobInput(null)
    }
  }

  dispose(): void {
    this.disable()
  }
}

export const cameraBobbingManifest: RendererModuleManifest = {
  id: 'cameraBobbing',
  controller: CameraBobbingModule,
  enabledDefault: true,
  cannotBeDisabled: true
}
