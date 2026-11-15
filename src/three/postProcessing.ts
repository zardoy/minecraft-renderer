import * as THREE from 'three'
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import {
  BLOOM_PREFILTER_FRAGMENT,
  BLUR_FRAGMENT,
  DOWNSAMPLE_FRAGMENT,
  FINAL_FRAGMENT,
  FULLSCREEN_VERTEX,
  GOD_RAYS_FRAGMENT,
  WORLD_COMPOSITE_FRAGMENT
} from './shaders/postEffectsGlsl'

export type AntialiasingMode = 'off' | 'fxaa'

export type PostEffectSettings = {
  antialiasing: AntialiasingMode
  /** Glow around light emitting blocks (needs the block shaders to write emission, see BlockEffects.setBlockEmission). */
  bloom: boolean
  godRays: boolean
  vignette: boolean
  motionBlur: boolean
}

export const POST_EFFECTS_OFF: PostEffectSettings = {
  antialiasing: 'off',
  bloom: false,
  godRays: false,
  vignette: false,
  motionBlur: false
}

/** What the world effects need to know about the frame. */
export type PostFrameInfo = {
  camera: THREE.PerspectiveCamera
  /** World position of the camera in float64 (scene coordinates are rebased). */
  cameraWorldPosition: { x: number; y: number; z: number }
  inWater: boolean
  /** World direction towards the sun and how strongly it shines (0 at night / no sky). */
  sunDirection: THREE.Vector3
  sunStrength: number
}

export const usesPostProcessing = (s: PostEffectSettings) => s.antialiasing !== 'off' || s.bloom || s.godRays || s.vignette || s.motionBlur

/** Effects of the final pass (whole frame, hand included). */
const usesFinalPass = (s: PostEffectSettings) => s.vignette

/** The block shaders must write light emission into the frame alpha. */
export const needsBlockEmission = (s: PostEffectSettings) => s.bloom

type PassMaterial = THREE.ShaderMaterial & { uniforms: Record<string, THREE.IUniform> }

const createPassMaterial = (name: string, fragmentShader: string, uniforms: Record<string, THREE.IUniform>): PassMaterial =>
  new THREE.ShaderMaterial({
    name,
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader,
    uniforms,
    glslVersion: THREE.GLSL3,
    // The canvas / targets depth is unrelated to these passes, never test or write it.
    depthTest: false,
    depthWrite: false
  }) as PassMaterial

const setDefines = (material: THREE.ShaderMaterial, wanted: Record<string, boolean>) => {
  let changed = false
  const defines = { ...material.defines }
  for (const [name, on] of Object.entries(wanted)) {
    if (on === name in defines) continue
    changed = true
    if (on) defines[name] = ''
    else delete defines[name]
  }
  if (changed) {
    material.defines = defines
    material.needsUpdate = true
  }
}

const colorTarget = (width: number, height: number, depthBuffer = false) =>
  new THREE.WebGLRenderTarget(width, height, {
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer
  })

/** Motion blur feels wrong past this camera move in one frame (teleport, respawn): skip the blur instead. */
const MAX_BLUR_MOVE = 4
/** Fraction of the per-frame camera motion that smears (a 180° shutter). */
const MOTION_BLUR_SHUTTER = 0.5

/**
 * Screen-space post effects.
 *
 * Frame flow when anything is on:
 * 1. `begin`: the world renders into `scene` (colour + depth texture, drawing buffer size).
 * 2. `afterWorld`: world effects (bloom, god rays, motion blur, distortion) composite `scene` into `world`, which then
 *    stays bound so the hand and waypoints draw on top, crisp. Without world effects the hand draws into `scene`.
 * 3. `end`: colour grading + vignette, then FXAA, to the canvas.
 *
 * Targets have the drawing buffer size, so viewports set by the hand pass (`renderer.setViewport`, canvas pixels ×
 * pixel ratio) still land in the right place, and log depth works as on the canvas. Colour management is off and the
 * output linear, so a target holds exactly what the canvas would.
 *
 * Off: `begin` returns without touching the renderer and every target is released, zero cost.
 */
export class PostProcessing {
  private scene?: THREE.WebGLRenderTarget
  private world?: THREE.WebGLRenderTarget
  private final?: THREE.WebGLRenderTarget
  private bloomHalf?: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]
  private bloomQuarter?: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]
  private rays?: THREE.WebGLRenderTarget
  private readonly materials = new Map<string, PassMaterial>()
  private quad?: FullScreenQuad
  private settings: PostEffectSettings = POST_EFFECTS_OFF
  private active = false
  private worldComposited = false
  private readonly size = new THREE.Vector2()
  // previous frame camera, for motion blur
  private prev?: { position: THREE.Vector3; quaternion: THREE.Quaternion; projection: THREE.Matrix4 }
  private readonly tmp = {
    quaternion: new THREE.Quaternion(),
    rotation: new THREE.Matrix4(),
    prevRelative: new THREE.Matrix4(),
    vec: new THREE.Vector3(),
    vec4: new THREE.Vector4()
  }

  /** True when the frame now renders offscreen: `afterWorld` and `end` must follow. */
  begin(renderer: THREE.WebGLRenderer, settings: PostEffectSettings): boolean {
    this.settings = settings
    if (!usesPostProcessing(settings) || renderer.xr.isPresenting) {
      if (this.scene) this.dispose()
      return false
    }
    renderer.getDrawingBufferSize(this.size)
    if (this.size.x === 0 || this.size.y === 0) return false
    this.resize(this.size.x, this.size.y)
    renderer.setRenderTarget(this.scene!)
    this.active = true
    this.worldComposited = false
    return true
  }

  /** After the world pass, before hand / overlays. */
  afterWorld(renderer: THREE.WebGLRenderer, frame: PostFrameInfo): void {
    if (!this.active) return
    const s = this.settings
    const rays = s.godRays && !frame.inWater && frame.sunStrength > 0 ? this.sunScreenPosition(frame) : undefined
    const blur = s.motionBlur ? this.motionBlurMatrix(frame) : undefined
    if (!s.bloom && !rays && !blur) return

    const scene = this.scene!
    this.world ??= colorTarget(scene.width, scene.height, true)
    if (this.world.width !== scene.width || this.world.height !== scene.height) this.world.setSize(scene.width, scene.height)
    const world = this.world
    const composite = this.material('composite', WORLD_COMPOSITE_FRAGMENT, {
      tScene: { value: null },
      tDepth: { value: null },
      sceneTexel: { value: new THREE.Vector2() },
      viewToPrevClip: { value: new THREE.Matrix4() },
      projectionScale: { value: new THREE.Vector2() },
      logFar: { value: 1 },
      blurScale: { value: MOTION_BLUR_SHUTTER },
      tBloomHalf: { value: null },
      tBloomQuarter: { value: null },
      bloomIntensity: { value: 0.9 },
      tRays: { value: null },
      raysColor: { value: new THREE.Color() }
    })
    setDefines(composite, { MOTION_BLUR: !!blur, BLOOM: s.bloom, GOD_RAYS: !!rays })
    const u = composite.uniforms
    u.tScene!.value = scene.texture
    u.tDepth!.value = scene.depthTexture
    u.sceneTexel!.value.set(1 / scene.width, 1 / scene.height)

    if (s.bloom) this.renderBloom(renderer)
    if (blur) {
      u.viewToPrevClip!.value.copy(blur)
      u.projectionScale!.value.set(frame.camera.projectionMatrix.elements[0], frame.camera.projectionMatrix.elements[5])
      u.logFar!.value = Math.log2(frame.camera.far + 1)
    }
    if (rays) {
      this.renderRays(renderer, rays.uv)
      // Warm white high in the sky, orange near the horizon.
      const low = 1 - THREE.MathUtils.smoothstep(frame.sunDirection.y, 0.05, 0.5)
      ;(u.raysColor!.value as THREE.Color).setRGB(1, 0.85 - 0.25 * low, 0.65 - 0.35 * low).multiplyScalar(0.55 * rays.strength * frame.sunStrength)
    }
    if (s.bloom) {
      u.tBloomHalf!.value = this.bloomHalf![0].texture
      u.tBloomQuarter!.value = this.bloomQuarter![0].texture
    }
    u.tRays!.value = this.rays?.texture ?? null

    this.drawPass(renderer, composite, world)
    // Hand and overlays draw on top with their own depth.
    renderer.setRenderTarget(world)
    renderer.clearDepth()
    this.worldComposited = true
  }

  /** Grading / vignette / FXAA of the whole frame to the canvas. */
  end(renderer: THREE.WebGLRenderer): void {
    if (!this.active) return
    this.active = false
    const s = this.settings
    const source = this.worldComposited ? this.world! : this.scene!
    const aa = s.antialiasing === 'fxaa'
    let input = source
    if (usesFinalPass(s) || !aa) {
      const final = this.finalMaterial()
      final.uniforms.tSource!.value = input.texture
      final.uniforms.aspect!.value = input.width / input.height
      const output = aa ? this.final! : null
      this.drawPass(renderer, final, output)
      if (output) input = output
    }
    if (aa) {
      const fxaa = this.material('fxaa', FXAAShader.fragmentShader, THREE.UniformsUtils.clone(FXAAShader.uniforms), FXAAShader.vertexShader)
      fxaa.uniforms.tDiffuse!.value = input.texture
      ;(fxaa.uniforms.resolution!.value as THREE.Vector2).set(1 / input.width, 1 / input.height)
      this.drawPass(renderer, fxaa, null)
    }
  }

  dispose(): void {
    for (const target of this.targets()) target.dispose()
    this.scene = this.world = this.final = this.rays = undefined
    this.bloomHalf = this.bloomQuarter = undefined
    for (const material of this.materials.values()) material.dispose()
    this.materials.clear()
    this.quad?.dispose()
    this.quad = undefined
    this.prev = undefined
    this.active = false
  }

  private targets(): THREE.WebGLRenderTarget[] {
    return [this.scene, this.world, this.final, this.rays, ...(this.bloomHalf ?? []), ...(this.bloomQuarter ?? [])].filter(
      (t): t is THREE.WebGLRenderTarget => !!t
    )
  }

  private resize(width: number, height: number): void {
    const s = this.settings
    if (!this.scene) {
      this.scene = colorTarget(width, height, true)
      this.scene.depthTexture = new THREE.DepthTexture(width, height, THREE.UnsignedIntType)
      this.scene.texture.name = 'postScene'
    }
    if (usesFinalPass(s) && s.antialiasing === 'fxaa') this.final ??= colorTarget(width, height)
    if (s.bloom) {
      this.bloomHalf ??= [colorTarget(1, 1), colorTarget(1, 1)]
      this.bloomQuarter ??= [colorTarget(1, 1), colorTarget(1, 1)]
    }
    if (s.godRays) this.rays ??= colorTarget(1, 1)
    const half = (v: number) => Math.max(1, Math.ceil(v / 2))
    const quarter = (v: number) => Math.max(1, Math.ceil(v / 4))
    const fit = (target: THREE.WebGLRenderTarget | undefined, w: number, h: number) => {
      if (target && (target.width !== w || target.height !== h)) target.setSize(w, h)
    }
    for (const target of [this.scene, this.final]) fit(target, width, height)
    for (const target of this.bloomHalf ?? []) fit(target, half(width), half(height))
    for (const target of this.bloomQuarter ?? []) fit(target, quarter(width), quarter(height))
    fit(this.rays, half(width), half(height))
  }

  private renderBloom(renderer: THREE.WebGLRenderer): void {
    const scene = this.scene!
    const [halfA, halfB] = this.bloomHalf!
    const [quarterA, quarterB] = this.bloomQuarter!
    const prefilter = this.material('bloomPrefilter', BLOOM_PREFILTER_FRAGMENT, {
      tScene: { value: null },
      tDepth: { value: null },
      sceneTexel: { value: new THREE.Vector2() }
    })
    prefilter.uniforms.tScene!.value = scene.texture
    prefilter.uniforms.tDepth!.value = scene.depthTexture
    prefilter.uniforms.sceneTexel!.value.set(1 / scene.width, 1 / scene.height)
    this.drawPass(renderer, prefilter, halfA)
    this.blur(renderer, halfA, halfB)
    const down = this.material('downsample', DOWNSAMPLE_FRAGMENT, { tSource: { value: null }, sourceTexel: { value: new THREE.Vector2() } })
    down.uniforms.tSource!.value = halfA.texture
    down.uniforms.sourceTexel!.value.set(1 / halfA.width, 1 / halfA.height)
    this.drawPass(renderer, down, quarterA)
    this.blur(renderer, quarterA, quarterB)
  }

  /** Separable blur of `target` in place (via `scratch`). */
  private blur(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, scratch: THREE.WebGLRenderTarget): void {
    const blur = this.material('blur', BLUR_FRAGMENT, { tSource: { value: null }, direction: { value: new THREE.Vector2() } })
    blur.uniforms.tSource!.value = target.texture
    blur.uniforms.direction!.value.set(1 / target.width, 0)
    this.drawPass(renderer, blur, scratch)
    blur.uniforms.tSource!.value = scratch.texture
    blur.uniforms.direction!.value.set(0, 1 / target.height)
    this.drawPass(renderer, blur, target)
  }

  private renderRays(renderer: THREE.WebGLRenderer, sunUv: THREE.Vector2): void {
    const scene = this.scene!
    const rays = this.material('godRays', GOD_RAYS_FRAGMENT, { tDepth: { value: null }, sunUv: { value: new THREE.Vector2() }, aspect: { value: 1 } })
    rays.uniforms.tDepth!.value = scene.depthTexture
    rays.uniforms.sunUv!.value.copy(sunUv)
    rays.uniforms.aspect!.value = scene.width / scene.height
    this.drawPass(renderer, rays, this.rays!)
  }

  /** Sun position on screen, undefined when it is behind the camera or far off screen. */
  private sunScreenPosition(frame: PostFrameInfo): { uv: THREE.Vector2; strength: number } | undefined {
    const camera = frame.camera
    camera.getWorldQuaternion(this.tmp.quaternion)
    // Direction only: rotate into view space, then project.
    const view = this.tmp.vec.copy(frame.sunDirection).applyQuaternion(this.tmp.quaternion.invert())
    if (view.z >= 0) return undefined
    const clip = this.tmp.vec4.set(view.x, view.y, view.z, 0).applyMatrix4(camera.projectionMatrix)
    if (clip.w <= 0) return undefined
    const ndcX = clip.x / clip.w
    const ndcY = clip.y / clip.w
    const strength = 1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(ndcX), Math.abs(ndcY)), 1, 1.8)
    if (strength <= 0) return undefined
    return { uv: new THREE.Vector2(ndcX * 0.5 + 0.5, ndcY * 0.5 + 0.5), strength }
  }

  /**
   * Current view space → previous frame clip space, both relative to the current camera position (float64 world
   * coordinates subtracted on the CPU). Undefined on the first frame and after a teleport.
   */
  private motionBlurMatrix(frame: PostFrameInfo): THREE.Matrix4 | undefined {
    const camera = frame.camera
    const position = new THREE.Vector3(frame.cameraWorldPosition.x, frame.cameraWorldPosition.y, frame.cameraWorldPosition.z)
    const quaternion = camera.getWorldQuaternion(new THREE.Quaternion())
    const previous = this.prev
    this.prev = { position, quaternion, projection: camera.projectionMatrix.clone() }
    if (!previous || previous.position.distanceTo(position) > MAX_BLUR_MOVE) return undefined
    const rotation = this.tmp.rotation.makeRotationFromQuaternion(quaternion)
    const prevRelative = this.tmp.prevRelative.compose(previous.position.clone().sub(position), previous.quaternion, new THREE.Vector3(1, 1, 1))
    return previous.projection.clone().multiply(prevRelative.invert()).multiply(rotation)
  }

  private finalMaterial(): PassMaterial {
    const s = this.settings
    const final = this.material('final', FINAL_FRAGMENT, {
      tSource: { value: null },
      aspect: { value: 1 },
      vignette: { value: 0.35 }
    })
    setDefines(final, { VIGNETTE: s.vignette })
    return final
  }

  private material(key: string, fragmentShader: string, uniforms: Record<string, THREE.IUniform>, vertexShader?: string): PassMaterial {
    let material = this.materials.get(key)
    if (!material) {
      material = vertexShader
        ? (new THREE.ShaderMaterial({ name: key, vertexShader, fragmentShader, uniforms, depthTest: false, depthWrite: false }) as PassMaterial)
        : createPassMaterial(key, fragmentShader, uniforms)
      this.materials.set(key, material)
    }
    return material
  }

  private drawPass(renderer: THREE.WebGLRenderer, material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null): void {
    this.quad ??= new FullScreenQuad()
    this.quad.material = material
    renderer.setRenderTarget(target)
    this.quad.render(renderer)
  }
}
