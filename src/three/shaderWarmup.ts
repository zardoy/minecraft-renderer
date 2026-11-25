import * as THREE from 'three'
import { LineMaterial, LineSegmentsGeometry, Wireframe } from 'three-stdlib'

/**
 * Compiles ahead of time the shader variants of things that show up later in the world: dropped items, items held by mobs and
 * players, item frames (see itemMesh.ts), the block highlight outline (cursorBlock.ts). Without it the first such object that
 * comes into view compiles its programs inside that frame: 45-97 ms frames on an iPhone 14 Pro while looking around. three.js caches programs by their parameters, so one hidden
 * object per material variant is enough. Variants also depend on the scene (fog, shadow map, tone mapping), so the compile runs
 * again when that changes; `compileAsync` uses KHR_parallel_shader_compile where the browser has it. The materials stay alive, so
 * their programs are not released (and compiled again) when the last real user disposes its material: the outline replaces its
 * LineMaterial on every colour / game mode change.
 */
export class ShaderWarmup {
  private lastSignature = ''
  private readonly group = new THREE.Group()
  private readonly texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
  private readonly geometry = new THREE.BoxGeometry(1, 1, 0)
  private readonly lineGeometry = new LineSegmentsGeometry().setPositions([0, 0, 0, 1, 1, 1])
  private readonly materials: THREE.Material[]

  constructor() {
    this.texture.needsUpdate = true
    // the materials itemMesh.ts creates
    this.materials = [
      new THREE.MeshStandardMaterial({ map: this.texture, transparent: true, alphaTest: 0.1 }),
      new THREE.MeshStandardMaterial({ map: this.texture, transparent: true, alphaTest: 0.1, side: THREE.DoubleSide }),
      new THREE.MeshBasicMaterial({ color: 0x00_00_00 }),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, alphaTest: 0.1, side: THREE.DoubleSide })
    ]
    // entities receive and cast shadows (entities.ts), which is part of the program key while the shadow map is on
    for (const receiveShadow of [false, true]) {
      for (const material of this.materials) {
        const mesh = new THREE.Mesh(this.geometry, material)
        mesh.receiveShadow = receiveShadow
        mesh.castShadow = receiveShadow
        this.group.add(mesh)
      }
    }
    const spriteMaterial = new THREE.SpriteMaterial({ map: this.texture, transparent: true, alphaTest: 0.1 })
    this.materials.push(spriteMaterial)
    this.group.add(new THREE.Sprite(spriteMaterial))
    // the block highlight outline (cursorBlock.ts): 96 ms frame on the iPhone when it compiled mid-game
    const lineMaterial = new LineMaterial({ color: 0x00_00_00, linewidth: 2 })
    this.materials.push(lineMaterial)
    this.group.add(new Wireframe(this.lineGeometry, lineMaterial))
  }

  /** Once per frame before rendering the scene: compiles when the scene state the variants depend on changed (and the first time). */
  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const fog = scene.fog ? ((scene.fog as THREE.FogExp2).isFogExp2 ? 'exp2' : 'linear') : 'none'
    const signature = `${renderer.shadowMap.enabled}|${renderer.shadowMap.type}|${fog}|${renderer.toneMapping}|${renderer.outputColorSpace}`
    if (signature === this.lastSignature) return
    this.lastSignature = signature
    renderer.compileAsync(this.group, camera, scene).catch(() => {})
  }

  dispose() {
    for (const material of this.materials) material.dispose()
    this.geometry.dispose()
    this.lineGeometry.dispose()
    this.texture.dispose()
  }
}
