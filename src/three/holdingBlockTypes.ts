import type * as THREE from 'three'
import type { WorldRendererConfig } from '../graphicsBackend'

export interface IHoldingBlock {
  ready: boolean
  holdingBlock: THREE.Object3D | undefined
  config: WorldRendererConfig
  isSwinging: boolean

  render(
    originalCamera: THREE.PerspectiveCamera,
    renderer: THREE.WebGLRenderer,
    ambientLight: THREE.AmbientLight,
    directionalLight: THREE.DirectionalLight
  ): void
  startSwing(): void
  stopSwing(): void
  updateItem(): void
  playBlockSwapAnimation(forceState: 'appeared' | 'disappeared'): Promise<boolean>
  dispose(): void
}
