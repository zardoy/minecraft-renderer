import * as THREE from 'three'

/** Contract for a main-menu background implementation (classic cubemap, v2 scene, etc.). */
export interface MenuBackgroundView {
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  init(): Promise<void>
  update(dt: number, sizeChanged: boolean): void
  dispose(): void
}

export function resizeMenuBackgroundCamera(
  camera: THREE.PerspectiveCamera,
  canvas: { width: number, height: number }
) {
  camera.aspect = canvas.width / canvas.height
  camera.updateProjectionMatrix()
}
