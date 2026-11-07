import * as THREE from 'three'
import cloudsPng from 'mc-assets/dist/other-textures/latest/environment/clouds.png'
import type { WorldRendererThree } from '../worldRendererThree'
import type { RendererModuleController, RendererModuleManifest } from '../rendererModuleSystem'
import { vanillaCelestialAngle, vanillaDayBrightness } from '../../lib/skyLight'

// Vanilla: clouds.png is 256×256, each texel a 12×12 block cell, slab 4 blocks thick.
const CELL_SIZE = 12
const TEXTURE_CELLS = 256
const PATTERN_PERIOD = CELL_SIZE * TEXTURE_CELLS
const THICKNESS = 4
/** Vanilla drifts the pattern 0.03 blocks per tick (20 TPS) toward -X. */
const DRIFT_BLOCKS_PER_SECOND = 0.03 * 20
/** Vanilla offsets the slab bottom by +0.33 from the dimension's cloud height. */
const HEIGHT_BIAS = 0.33
const MIN_RADIUS = 256
const MAX_RADIUS = 768
const OPACITY = 0.8
/** Vanilla shades the underside darker than the top. */
const BOTTOM_SHADE = 0.7

const threeVersion = parseInt(THREE.REVISION.replaceAll(/\D+/g, ''), 10)

const vertexShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec2 vLocal;
  void main() {
    vLocal = (modelMatrix * vec4(position, 1.0)).xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`

const fragmentShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D map;
  uniform vec2 patternOffset;
  uniform vec3 color;
  uniform float opacity;
  uniform float fadeStart;
  uniform float fadeEnd;
  varying vec2 vLocal;
  void main() {
    #include <logdepthbuf_fragment>
    float cover = texture2D(map, (vLocal + patternOffset) / ${PATTERN_PERIOD.toFixed(1)}).a;
    if (cover < 0.5) discard;
    float alpha = opacity * (1.0 - smoothstep(fadeStart, fadeEnd, length(vLocal)));
    if (alpha <= 0.0) discard;
    gl_FragColor = vec4(color, alpha);
    #include <tonemapping_fragment>
    #include <${threeVersion >= 154 ? 'colorspace_fragment' : 'encodings_fragment'}>
  }
`

/**
 * Flat "fast graphics" clouds: one camera-following quad, the cloud mask is sampled from
 * vanilla clouds.png in the fragment shader, so there is no per-cell geometry to rebuild
 * as the player moves or the pattern drifts.
 */
export class CloudsModule implements RendererModuleController {
  private mesh?: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  private enabled = false
  private drift = 0
  private timeOfDay: number
  private readonly linearColor = new THREE.Color()

  constructor(private readonly worldRenderer: WorldRendererThree) {
    this.timeOfDay = worldRenderer.timeOfTheDay
  }

  enable(): void {
    if (this.enabled) return
    this.enabled = true
    if (!this.mesh) this.create()
    this.mesh!.visible = true
  }

  disable(): void {
    if (!this.enabled) return
    this.enabled = false
    if (this.mesh) this.mesh.visible = false
  }

  autoEnableCheck(): boolean {
    const cfg = this.worldRenderer.worldRendererConfig
    return cfg.clouds && cfg.cardinalLight !== 'nether'
  }

  updateTimeOfDay(time: number): void {
    this.timeOfDay = time
  }

  render?: (deltaTime: number) => void = deltaTime => {
    this.drift = (this.drift + deltaTime * DRIFT_BLOCKS_PER_SECOND) % PATTERN_PERIOD
  }

  dispose(): void {
    if (!this.mesh) return
    this.worldRenderer.scene.remove(this.mesh)
    this.mesh.geometry.dispose()
    this.mesh.material.uniforms.map.value?.dispose()
    this.mesh.material.dispose()
    this.mesh = undefined
  }

  private create(): void {
    const map = new THREE.TextureLoader().load(cloudsPng)
    map.wrapS = THREE.RepeatWrapping
    map.wrapT = THREE.RepeatWrapping
    map.magFilter = THREE.NearestFilter
    map.minFilter = THREE.NearestFilter
    map.generateMipmaps = false
    // Keep png row 0 at -Z like vanilla's texture-to-world mapping.
    map.flipY = false

    const material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: map },
        patternOffset: { value: new THREE.Vector2() },
        color: { value: new THREE.Color(1, 1, 1) },
        opacity: { value: OPACITY },
        fadeStart: { value: MIN_RADIUS * 0.55 },
        fadeEnd: { value: MIN_RADIUS }
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      forceSinglePass: true
    })

    const geometry = new THREE.PlaneGeometry(2, 2)
    geometry.rotateX(-Math.PI / 2)

    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = 'clouds'
    mesh.frustumCulled = false
    // After sun/moon (-2) and stars (-1), before other transparents so water/glass composite on top.
    mesh.renderOrder = -0.5
    mesh.onBeforeRender = () => this.syncToCamera(mesh)
    this.mesh = mesh
    this.worldRenderer.scene.add(mesh)
  }

  private syncToCamera(mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>): void {
    const { sceneOrigin, viewDistance, worldRendererConfig } = this.worldRenderer
    const { uniforms } = mesh.material

    const radius = THREE.MathUtils.clamp(viewDistance * 16 * 2, MIN_RADIUS, MAX_RADIUS)
    uniforms.fadeStart.value = radius * 0.55
    uniforms.fadeEnd.value = radius

    // Show the slab bottom from below and its top from above, like a 4-block-thick cloud.
    const bottom = worldRendererConfig.cloudHeight + HEIGHT_BIAS
    const fromBelow = sceneOrigin.y < bottom + THICKNESS / 2
    const planeY = fromBelow ? bottom : bottom + THICKNESS
    mesh.position.set(0, planeY - sceneOrigin.y, 0)
    mesh.scale.set(radius, 1, radius)
    mesh.updateMatrixWorld()

    // Wrap on the CPU in doubles so the shader never sees large world coordinates.
    const wrap = (v: number) => ((v % PATTERN_PERIOD) + PATTERN_PERIOD) % PATTERN_PERIOD
    uniforms.patternOffset.value.set(wrap(sceneOrigin.x + this.drift), wrap(sceneOrigin.z))

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
    const shade = fromBelow ? BOTTOM_SHADE : 1
    this.linearColor.setRGB(r * shade, g * shade, b * shade, THREE.SRGBColorSpace)
    uniforms.color.value.copy(this.linearColor)
  }
}

export const cloudsManifest: RendererModuleManifest = {
  id: 'clouds',
  controller: CloudsModule,
  enabledDefault: true
}
