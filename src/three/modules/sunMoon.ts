import * as THREE from 'three'
import sunPng from 'mc-assets/dist/other-textures/latest/environment/sun.png'
import moonPhasesPng from 'mc-assets/dist/other-textures/latest/environment/moon_phases.png'
import type { WorldRendererThree } from '../worldRendererThree'
import type { RendererModuleController, RendererModuleManifest } from '../rendererModuleSystem'
import { vanillaCelestialAngle } from '../../lib/skyLight'

// Vanilla geometry: sun quad ±30 and moon quad ±20, both 100 blocks from the camera.
const DISTANCE = 100
const SUN_SIZE = 60
const MOON_SIZE = 40
/** moon_phases.png is a 4×2 grid. */
const MOON_COLS = 4
const MOON_ROWS = 2

const loadPixelTexture = (url: string, onLoad?: (tex: THREE.Texture) => void): THREE.Texture => {
  const tex = new THREE.TextureLoader().load(url, onLoad)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  return tex
}

const createBodyMaterial = (map: THREE.Texture) =>
  new THREE.MeshBasicMaterial({
    map,
    transparent: true,
    // Vanilla blends celestial bodies with (SRC_ALPHA, ONE): additive over the sky colour.
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    // Terrain drawn in the opaque pass must still hide the sun/moon.
    depthTest: true,
    fog: false,
    side: THREE.DoubleSide,
    forceSinglePass: true
  })

export class SunMoonModule implements RendererModuleController {
  private pivot?: THREE.Group
  private sun?: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  private moon?: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  private moonTexture?: THREE.Texture
  private enabled = false
  private timeOfDay: number
  private moonPhase = 0

  constructor(private readonly worldRenderer: WorldRendererThree) {
    this.timeOfDay = worldRenderer.timeOfTheDay
  }

  enable(): void {
    if (this.enabled) return
    this.enabled = true
    if (!this.pivot) this.create()
    this.pivot!.visible = true
    this.applyTime()
  }

  disable(): void {
    if (!this.enabled) return
    this.enabled = false
    if (this.pivot) this.pivot.visible = false
  }

  autoEnableCheck(): boolean {
    const cfg = this.worldRenderer.worldRendererConfig
    return cfg.defaultSkybox && cfg.cardinalLight !== 'nether'
  }

  updateTimeOfDay(time: number): void {
    this.timeOfDay = time
    if (this.enabled) this.applyTime()
  }

  updateMoonPhase(phase: number): void {
    this.moonPhase = ((Math.trunc(phase) % 8) + 8) % 8
    this.applyMoonPhase()
  }

  dispose(): void {
    if (!this.pivot) return
    this.worldRenderer.scene.remove(this.pivot)
    for (const mesh of [this.sun, this.moon]) {
      if (!mesh) continue
      mesh.geometry.dispose()
      mesh.material.map?.dispose()
      mesh.material.dispose()
    }
    this.pivot = undefined
    this.sun = undefined
    this.moon = undefined
    this.moonTexture = undefined
  }

  private create(): void {
    this.pivot = new THREE.Group()
    this.pivot.name = 'sun-moon'

    const sunGeometry = new THREE.PlaneGeometry(SUN_SIZE, SUN_SIZE)
    sunGeometry.rotateX(Math.PI / 2)
    this.sun = new THREE.Mesh(sunGeometry, createBodyMaterial(loadPixelTexture(sunPng)))
    this.sun.position.set(0, DISTANCE, 0)

    this.moonTexture = loadPixelTexture(moonPhasesPng)
    this.moonTexture.repeat.set(1 / MOON_COLS, 1 / MOON_ROWS)
    const moonGeometry = new THREE.PlaneGeometry(MOON_SIZE, MOON_SIZE)
    moonGeometry.rotateX(-Math.PI / 2)
    this.moon = new THREE.Mesh(moonGeometry, createBodyMaterial(this.moonTexture))
    this.moon.position.set(0, -DISTANCE, 0)

    for (const mesh of [this.sun, this.moon]) {
      mesh.frustumCulled = false
      // Drawn before stars (-1) and clouds so both composite on top, like vanilla.
      mesh.renderOrder = -2
      this.pivot.add(mesh)
    }

    this.applyMoonPhase()
    this.worldRenderer.scene.add(this.pivot)
  }

  private applyMoonPhase(): void {
    if (!this.moonTexture) return
    const col = this.moonPhase % MOON_COLS
    const row = Math.floor(this.moonPhase / MOON_COLS)
    // flipY textures put row 0 (top of the png) at v = 1 - 1/rows.
    this.moonTexture.offset.set(col / MOON_COLS, 1 - (row + 1) / MOON_ROWS)
  }

  private applyTime(): void {
    if (!this.pivot || !this.sun || !this.moon) return
    // Rotating +Y about Z by θ gives (-sinθ, cosθ, 0): sunrise in the east (+X),
    // overhead at noon, setting in the west (-X).
    const theta = vanillaCelestialAngle(this.timeOfDay) * Math.PI * 2
    this.pivot.rotation.z = theta

    // There is no horizon occluder on the flat sky planes, so fade bodies out as they sink
    // below it instead of letting them shine through the void colour.
    const sunHeight = Math.cos(theta)
    this.sun.material.opacity = THREE.MathUtils.smoothstep(sunHeight, -0.15, 0.02)
    this.moon.material.opacity = THREE.MathUtils.smoothstep(-sunHeight, -0.15, 0.02)
  }
}

export const sunMoonManifest: RendererModuleManifest = {
  id: 'sunMoon',
  controller: SunMoonModule,
  enabledDefault: true
}
