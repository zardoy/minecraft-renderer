/**
 * Volumetric light scattering ("god rays") as a TSL post pass.
 *
 * Classic screen-space radial blur (Mitchell / GPU Gems 3 "Crepuscular Rays"): march from
 * each pixel toward the sun's screen position, accumulating a brightness mask with
 * exponential decay. Cheap, no extra geometry, and it reads correctly against the block
 * world because the mask is built from scene luminance rather than a separate occlusion
 * render.
 *
 * Deliberately screen-space: a true volumetric march would cost more than the entire
 * geometry pass on the mobile GPUs this renderer targets.
 */

import * as THREE from 'three/webgpu'
import { Fn, vec2, vec3, vec4, float, uniform, uv, texture, max, pow, clamp, smoothstep, dot, length } from 'three/tsl'

export type GodRaysUniforms = ReturnType<typeof createGodRaysUniforms>

export function createGodRaysUniforms() {
  return {
    /** Sun position in normalised screen space (0..1). */
    sunScreenPos: uniform(new THREE.Vector2(0.5, 0.75)),
    /** Ray colour, usually a warm tint of the sun. */
    rayColor: uniform(new THREE.Color(1, 0.92, 0.72)),
    density: uniform(0.9),
    weight: uniform(0.32),
    decay: uniform(0.95),
    exposure: uniform(0.5),
    /** Luminance above which a pixel contributes to the rays. */
    threshold: uniform(0.75),
    /** Fades the whole effect out as the sun leaves the screen. */
    intensity: uniform(1)
  }
}

const SAMPLE_COUNT = 48

/**
 * Builds the god-rays composite node.
 *
 * @param sceneColor the rendered scene as a texture node (e.g. `pass(scene, camera).getTextureNode()`)
 */
export function godRaysNode(sceneColor: any, u: GodRaysUniforms = createGodRaysUniforms()) {
  return Fn(() => {
    const screenUv = uv().toVar()
    const base = sceneColor.sample(screenUv).toVar()

    // Step from the pixel toward the sun, shrinking each iteration.
    const delta = screenUv.sub(u.sunScreenPos).toVar()
    delta.assign(delta.mul(float(1).div(float(SAMPLE_COUNT)).mul(u.density)))

    const sampleUv = screenUv.toVar()
    const illumination = float(1).toVar()
    const accum = vec3(0).toVar()

    for (let i = 0; i < SAMPLE_COUNT; i++) {
      sampleUv.assign(sampleUv.sub(delta))
      const s = sceneColor.sample(clamp(sampleUv, vec2(0), vec2(1))).rgb
      // Mask: only bright pixels (sky / sun disc) scatter.
      const luma = dot(s, vec3(0.2126, 0.7152, 0.0722))
      const masked = s.mul(smoothstep(u.threshold, float(1), luma))
      accum.addAssign(masked.mul(illumination).mul(u.weight))
      illumination.mulAssign(u.decay)
    }

    // Fade out when the sun is off-screen, otherwise rays streak from the edge.
    const offscreen = clamp(length(u.sunScreenPos.sub(vec2(0.5))).mul(1.6), 0, 1)
    const falloff = float(1).sub(pow(offscreen, float(2)))

    const rays = accum.mul(u.exposure).mul(u.rayColor).mul(u.intensity).mul(max(falloff, float(0)))
    return vec4(base.rgb.add(rays), base.a)
  })()
}

/**
 * Projects a world-space sun direction into the normalised screen position the shader
 * wants, and returns whether the sun is in front of the camera.
 */
const _sunWorld = new THREE.Vector3()

export function updateSunScreenPos(u: GodRaysUniforms, sunDirection: THREE.Vector3, camera: THREE.Camera, distance = 5000): boolean {
  _sunWorld.copy(sunDirection).normalize().multiplyScalar(distance).add(camera.position)
  const projected = _sunWorld.clone().project(camera)

  // z > 1 means behind the camera after projection.
  const inFront = projected.z < 1
  u.sunScreenPos.value.set((projected.x + 1) / 2, (projected.y + 1) / 2)
  u.intensity.value = inFront ? 1 : 0
  return inFront
}

/**
 * Convenience wrapper: renders `scene` through a god-rays composite.
 * Returns the `PostProcessing` instance to call `.renderAsync()` on instead of the renderer.
 */
export function createGodRaysPostProcessing(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, u = createGodRaysUniforms()) {
  const post = new THREE.PostProcessing(renderer)
  const scenePass = (THREE as any).pass(scene, camera)
  post.outputNode = godRaysNode(scenePass.getTextureNode(), u)
  return { post, uniforms: u }
}
