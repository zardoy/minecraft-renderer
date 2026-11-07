import * as THREE from 'three'
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'

export type AntialiasingMode = 'off' | 'fxaa'

/**
 * Screen-space post effects of the world frame (currently FXAA).
 *
 * When an effect is on, `begin` redirects the whole frame (world, hand, waypoints) into an offscreen target of the
 * drawing buffer size and `end` draws it to the canvas through the effect. Same size as the canvas means viewports set
 * by the hand pass (`renderer.setViewport`, applied in canvas pixels × pixel ratio) still land in the right place, and
 * the target keeps its own depth buffer so log depth works as on the canvas. Colour management is off and the output
 * is linear, so the target holds exactly what the canvas would.
 *
 * Off: `begin` returns without touching the renderer and the target is released, zero cost.
 */
export class PostProcessing {
  private target?: THREE.WebGLRenderTarget
  private fxaa?: { material: THREE.ShaderMaterial; quad: FullScreenQuad }
  private active = false
  private readonly size = new THREE.Vector2()

  /** True when the frame now renders offscreen and `end` must be called. */
  begin(renderer: THREE.WebGLRenderer, mode: AntialiasingMode): boolean {
    if (mode === 'off' || renderer.xr.isPresenting) {
      if (this.target) this.dispose()
      return false
    }
    renderer.getDrawingBufferSize(this.size)
    if (this.size.x === 0 || this.size.y === 0) return false
    const target = this.ensureTarget(this.size.x, this.size.y)
    renderer.setRenderTarget(target)
    this.active = true
    return true
  }

  end(renderer: THREE.WebGLRenderer): void {
    if (!this.active || !this.target) return
    this.active = false
    renderer.setRenderTarget(null)
    const fxaa = this.ensureFxaa()
    fxaa.material.uniforms.tDiffuse!.value = this.target.texture
    ;(fxaa.material.uniforms.resolution!.value as THREE.Vector2).set(1 / this.target.width, 1 / this.target.height)
    fxaa.quad.render(renderer)
  }

  dispose(): void {
    this.target?.dispose()
    this.target = undefined
    this.fxaa?.material.dispose()
    this.fxaa?.quad.dispose()
    this.fxaa = undefined
    this.active = false
  }

  private ensureTarget(width: number, height: number): THREE.WebGLRenderTarget {
    if (this.target && this.target.width === width && this.target.height === height) return this.target
    if (this.target) {
      this.target.setSize(width, height)
      return this.target
    }
    this.target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.UnsignedByteType,
      // FXAA samples between pixels
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: true
    })
    this.target.texture.name = 'postProcessingScene'
    return this.target
  }

  private ensureFxaa() {
    if (!this.fxaa) {
      const material = new THREE.ShaderMaterial({
        name: FXAAShader.name,
        uniforms: THREE.UniformsUtils.clone(FXAAShader.uniforms),
        vertexShader: FXAAShader.vertexShader,
        fragmentShader: FXAAShader.fragmentShader,
        // The canvas depth buffer is not cleared while rendering offscreen, never test against it.
        depthTest: false,
        depthWrite: false
      })
      this.fxaa = { material, quad: new FullScreenQuad(material) }
    }
    return this.fxaa
  }
}
