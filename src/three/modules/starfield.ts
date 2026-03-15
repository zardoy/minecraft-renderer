import * as THREE from 'three'
import type { WorldRendererThree } from '../worldRendererThree'
import type { RendererModuleController, RendererModuleManifest } from '../rendererModuleSystem'

// Get Three.js revision as integer
const threeVersion = parseInt(THREE.REVISION.replaceAll(/\D+/g, ''), 10)

class StarfieldMaterial extends THREE.ShaderMaterial {
  constructor() {
    super({
      uniforms: { time: { value: 0 }, fade: { value: 1 } },
      vertexShader: /* glsl */ `
        uniform float time;
        attribute float size;
        varying vec3 vColor;
        attribute vec3 color;
        void main() {
          vColor = color;
          vec4 mvPosition = modelViewMatrix * vec4(position, 0.5);
          gl_PointSize = 0.7 * size * (30.0 / -mvPosition.z) * (3.0 + sin(time + 100.0));
          gl_Position = projectionMatrix * mvPosition;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D pointTexture;
        uniform float fade;
        varying vec3 vColor;
        void main() {
          float opacity = 1.0;
          gl_FragColor = vec4(vColor, 1.0);

          #include <tonemapping_fragment>
          #include <${threeVersion >= 154 ? 'colorspace_fragment' : 'encodings_fragment'}>
        }`,
    })
  }
}

export class StarfieldModule implements RendererModuleController {
  private points?: THREE.Points
  private clock = new THREE.Clock()
  private enabled = false
  private currentTime?: number

  constructor(private readonly worldRenderer: WorldRendererThree) { }

  enable(): void {
    if (this.enabled) return
    this.enabled = true
    this.updateVisibility()
  }

  disable(): void {
    if (!this.enabled) return
    this.enabled = false
    this.removeStars()
  }

  toggle(): boolean {
    if (this.enabled) {
      this.disable()
    } else {
      this.enable()
    }
    return this.enabled
  }

  enablementCheck?: () => boolean = () => {
    if (!this.currentTime) return false
    const nightTime = 13_500
    const morningStart = 23_000
    return this.currentTime > nightTime && this.currentTime < morningStart
  }

  render?: (deltaTime: number) => void = (_deltaTime) => {
    if (!this.points) return
    this.points.position.copy(this.worldRenderer.getCameraPosition())
      ; (this.points.material as StarfieldMaterial).uniforms.time.value =
        this.clock.getElapsedTime() * 0.2
  }

  /**
   * Update visibility based on time of day (0-24000 Minecraft ticks).
   */
  updateTimeOfDay(time: number): void {
    this.currentTime = time
    if (this.enabled) {
      this.updateVisibility()
    }
  }

  private updateVisibility(): void {
    if (!this.enabled) return
    const shouldShow = this.enablementCheck?.() ?? false
    if (shouldShow && !this.points) {
      this.createStars()
    } else if (!shouldShow && this.points) {
      this.removeStars()
    }
  }

  private createStars(): void {
    if (this.points) return

    const radius = 80
    const depth = 50
    const count = 7000
    const factor = 7
    const saturation = 10

    const geometry = new THREE.BufferGeometry()

    const genStar = (r: number): THREE.Vector3 =>
      new THREE.Vector3().setFromSpherical(
        new THREE.Spherical(
          r,
          Math.acos(1 - Math.random() * 2),
          Math.random() * 2 * Math.PI
        )
      )

    const positions: number[] = []
    const colors: number[] = []
    const sizes = Array.from({ length: count }, () => (0.5 + 0.5 * Math.random()) * factor)
    const color = new THREE.Color()
    let r = radius + depth
    const increment = depth / count

    for (let i = 0; i < count; i++) {
      r -= increment * Math.random()
      positions.push(...genStar(r).toArray())
      color.setHSL(i / count, saturation, 0.9)
      colors.push(color.r, color.g, color.b)
    }

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    geometry.setAttribute('size', new THREE.Float32BufferAttribute(sizes, 1))

    const material = new StarfieldMaterial()
    material.blending = THREE.AdditiveBlending
    material.depthTest = false
    material.transparent = true

    this.points = new THREE.Points(geometry, material)
    this.points.renderOrder = -1
    this.worldRenderer.scene.add(this.points)
  }

  dispose(): void {
    this.removeStars()
  }

  private removeStars(): void {
    if (!this.points) return

    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose()
    this.worldRenderer.scene.remove(this.points)
    this.points = undefined
  }
}

export const starfieldManifest: RendererModuleManifest = {
  id: 'starfield',
  controller: StarfieldModule,
  enabledDefault: true,
  cannotBeDisabled: true,
}
