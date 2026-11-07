import * as THREE from 'three'
import cloudsPng from 'mc-assets/dist/other-textures/latest/environment/clouds.png'
import type { WorldRendererThree } from '../worldRendererThree'
import type { RendererModuleController, RendererModuleManifest } from '../rendererModuleSystem'
import { vanillaCelestialAngle, vanillaDayBrightness } from '../../lib/skyLight'
import { loadCloudCover } from '../cloudCover'
import { buildCloudGeometry, CLOUD_CELL_SIZE, type CloudCover } from '../cloudGeometry'

/** Vanilla drifts the pattern 0.03 blocks per tick (20 TPS) toward -X. */
const DRIFT_BLOCKS_PER_SECOND = 0.03 * 20
/** Vanilla offsets the slab bottom by +0.33 from the dimension's cloud height. */
const HEIGHT_BIAS = 0.33
const MIN_RADIUS = 256
const MAX_RADIUS = 576
const OPACITY = 0.8

const threeVersion = parseInt(THREE.REVISION.replaceAll(/\D+/g, ''), 10)

const vertexShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float shade;
  varying vec2 vLocal;
  varying float vShade;
  void main() {
    vLocal = (modelMatrix * vec4(position, 1.0)).xz;
    vShade = shade;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`

const fragmentShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 color;
  uniform float opacity;
  uniform float fadeStart;
  uniform float fadeEnd;
  varying vec2 vLocal;
  varying float vShade;
  void main() {
    #include <logdepthbuf_fragment>
    float alpha = opacity * (1.0 - smoothstep(fadeStart, fadeEnd, length(vLocal)));
    if (alpha <= 0.0) discard;
    gl_FragColor = vec4(color * vShade, alpha);
    #include <tonemapping_fragment>
    #include <${threeVersion >= 154 ? 'colorspace_fragment' : 'encodings_fragment'}>
  }
`

/**
 * Vanilla "fancy" clouds: a 4-block-thick slab of 12×12 cells taken from clouds.png, with real top,
 * bottom and side faces. The cells around the camera are rebuilt only when the camera or the drifting
 * pattern crosses a cell boundary; everything finer than that is a mesh position offset.
 * A colour-less depth pre-pass over the same geometry keeps overlapping faces from blending twice.
 */
export class CloudsModule implements RendererModuleController {
  private readonly group = new THREE.Group()
  private readonly uniforms = {
    color: { value: new THREE.Color(1, 1, 1) },
    opacity: { value: OPACITY },
    fadeStart: { value: MIN_RADIUS * 0.55 },
    fadeEnd: { value: MIN_RADIUS }
  }
  private meshes?: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[]
  private cover?: CloudCover
  private builtKey = ''
  private enabled = false
  private drift = 0
  private timeOfDay: number
  private readonly linearColor = new THREE.Color()

  constructor(private readonly worldRenderer: WorldRendererThree) {
    this.timeOfDay = worldRenderer.timeOfTheDay
    this.group.name = 'clouds'
  }

  enable(): void {
    if (this.enabled) return
    this.enabled = true
    if (!this.meshes) this.create()
    this.group.visible = true
  }

  disable(): void {
    if (!this.enabled) return
    this.enabled = false
    this.group.visible = false
  }

  autoEnableCheck(): boolean {
    const cfg = this.worldRenderer.worldRendererConfig
    return cfg.clouds && cfg.cardinalLight !== 'nether'
  }

  updateTimeOfDay(time: number): void {
    this.timeOfDay = time
  }

  render?: (deltaTime: number) => void = deltaTime => {
    // Not wrapped: cell indices wrap in the lookup, and wrapping here would force a rebuild.
    this.drift += deltaTime * DRIFT_BLOCKS_PER_SECOND
  }

  dispose(): void {
    if (!this.meshes) return
    this.worldRenderer.scene.remove(this.group)
    this.meshes[0].geometry.dispose()
    for (const mesh of this.meshes) mesh.material.dispose()
    this.meshes = undefined
    this.cover = undefined
    this.builtKey = ''
  }

  private create(): void {
    const shared = {
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      side: THREE.DoubleSide,
      transparent: true,
      forceSinglePass: true
    }
    const main = new THREE.ShaderMaterial({ ...shared, depthWrite: false })
    // Same program, so its depth matches the main pass exactly.
    const depthOnly = new THREE.ShaderMaterial({ ...shared, depthWrite: true, colorWrite: false })

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3))

    // After sun/moon (-2) and stars (-1), before other transparents so water/glass composite on top.
    const passes: [THREE.ShaderMaterial, number][] = [
      [depthOnly, -0.6],
      [main, -0.5]
    ]
    this.meshes = passes.map(([material, renderOrder]) => {
      const mesh = new THREE.Mesh(geometry, material)
      mesh.frustumCulled = false
      mesh.renderOrder = renderOrder
      this.group.add(mesh)
      return mesh
    })
    // The depth pre-pass is drawn first, so syncing there positions both passes.
    this.meshes[0].onBeforeRender = () => this.syncToCamera()
    this.worldRenderer.scene.add(this.group)

    loadCloudCover(cloudsPng).then(
      cover => {
        this.cover = cover
      },
      error => console.warn('Failed to load clouds.png, clouds will not render', error)
    )
  }

  private rebuild(centerX: number, centerZ: number, radiusCells: number): void {
    const data = buildCloudGeometry(this.cover!, centerX, centerZ, radiusCells)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3))
    geometry.setAttribute('shade', new THREE.BufferAttribute(data.shades, 1))
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1))

    const meshes = this.meshes!
    const old = meshes[0].geometry
    for (const mesh of meshes) mesh.geometry = geometry
    old.dispose()
  }

  private syncToCamera(): void {
    const { sceneOrigin, viewDistance, worldRendererConfig } = this.worldRenderer

    const radius = THREE.MathUtils.clamp(viewDistance * 16 * 2, MIN_RADIUS, MAX_RADIUS)
    this.uniforms.fadeStart.value = radius * 0.55
    this.uniforms.fadeEnd.value = radius

    // Pattern space is world space shifted by the drift, so world x = pattern x - drift.
    const centerX = Math.floor((sceneOrigin.x + this.drift) / CLOUD_CELL_SIZE)
    const centerZ = Math.floor(sceneOrigin.z / CLOUD_CELL_SIZE)
    if (this.cover) {
      const radiusCells = Math.ceil(radius / CLOUD_CELL_SIZE)
      const key = `${centerX},${centerZ},${radiusCells}`
      if (key !== this.builtKey) {
        this.builtKey = key
        this.rebuild(centerX, centerZ, radiusCells)
      }
    }

    // Compute in doubles so the GPU only ever sees camera-relative offsets.
    const bottom = worldRendererConfig.cloudHeight + HEIGHT_BIAS
    this.group.position.set(centerX * CLOUD_CELL_SIZE - this.drift - sceneOrigin.x, bottom - sceneOrigin.y, centerZ * CLOUD_CELL_SIZE - sceneOrigin.z)
    this.group.updateMatrixWorld(true)

    const day = vanillaDayBrightness(vanillaCelestialAngle(this.timeOfDay))
    let r = day * 0.9 + 0.1
    let g = day * 0.9 + 0.1
    let b = day * 0.85 + 0.15
    if (worldRendererConfig.isRaining) {
      // Vanilla desaturates and darkens clouds toward grey while raining.
      const grey = (r * 0.3 + g * 0.59 + b * 0.11) * 0.6
      r = r * 0.05 + grey * 0.95
      g = g * 0.05 + grey * 0.95
      b = b * 0.05 + grey * 0.95
    }
    this.linearColor.setRGB(r, g, b, THREE.SRGBColorSpace)
    this.uniforms.color.value.copy(this.linearColor)
  }
}

export const cloudsManifest: RendererModuleManifest = {
  id: 'clouds',
  controller: CloudsModule,
  enabledDefault: true
}
