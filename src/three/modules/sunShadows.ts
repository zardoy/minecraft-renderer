import * as THREE from 'three'
import type { WorldRendererThree } from '../worldRendererThree'
import type { RendererModuleController, RendererModuleManifest } from '../rendererModuleSystem'
import type { GlobalBlockBuffer } from '../globalBlockBuffer'
import type { GlobalLegacyBuffer } from '../globalLegacyBuffer'
import type { CubeDrawSpan } from '../cubeDrawSpans'
import type { LegacyDrawSpan } from '../legacyMultiDraw'
import { createCubeShadowCasterMaterial } from '../shaders/cubeBlockShader'
import { createGlobalLegacyShadowCasterMaterial } from '../shaders/legacyBlockShader'
import type { SunShadowsMode } from '../blockEffects'
import { SmoothTimeOfDay } from '../smoothTimeOfDay'
import {
  computeShadowFrame,
  parseSectionKey,
  sectionCastsIntoRange,
  shadowNeedsRerender,
  sunDirectionFromTime,
  sunShadowStrength,
  type ShadowFrame,
  type ShadowRerenderState
} from '../sunShadowMath'

export const SHADOW_MAP_SIZE = 2048
export const MIN_SHADOW_DISTANCE = 16
export const MAX_SHADOW_DISTANCE = 128

type Caster<B, S> = { buffer: B; mesh: THREE.Mesh; material: THREE.ShaderMaterial; spans: S[] }

/** Distance from the option, clamped: the map covers twice this plus a margin, so large values blur the shadows. */
export function resolveShadowDistance(value: number): number {
  if (!Number.isFinite(value)) return 64
  return Math.min(MAX_SHADOW_DISTANCE, Math.max(MIN_SHADOW_DISTANCE, Math.round(value)))
}

/**
 * Sun shadows on chunk geometry (shader cubes and opaque legacy geometry cast and receive).
 *
 * One directional shadow map that follows the camera. It is not rendered every frame: only when the sun moved
 * noticeably, the snapped map center moved, the render origin was rebased or chunk buffers changed (throttled).
 * Nothing is rendered at night. The pass draws the global buffers again with depth-only materials, restricted to
 * sections around the camera.
 */
export class SunShadowsModule implements RendererModuleController {
  private enabled = false
  private readonly timeOfDay = new SmoothTimeOfDay()
  private target?: THREE.WebGLRenderTarget
  private readonly shadowScene = new THREE.Scene()
  // three needs a camera to render, the casters project with u_lightViewProj and are never frustum culled.
  private readonly shadowCamera = new THREE.OrthographicCamera()
  private readonly lightViewProj = { value: new THREE.Matrix4() }
  private readonly sunDir = new THREE.Vector3()
  private cubeCaster?: Caster<GlobalBlockBuffer, CubeDrawSpan>
  private legacyCaster?: Caster<GlobalLegacyBuffer, LegacyDrawSpan>
  private lastRender?: ShadowRerenderState
  private readonly bufferIds = new WeakMap<object, number>()
  private nextBufferId = 1
  /** Number of shadow map renders, for debugging and tests. */
  renderCount = 0

  constructor(private readonly worldRenderer: WorldRendererThree) {
    this.timeOfDay.update(worldRenderer.timeOfTheDay, performance.now())
  }

  enable(): void {
    if (this.enabled) return
    this.enabled = true
    // Receivers sample the map as soon as the define is on, even at night: a sampler2DShadow without an allocated
    // depth texture makes their draws fail. Allocate and clear it (= fully lit) right away.
    this.clearMap()
    this.worldRenderer.blockEffects.uniforms.u_shadowMap.value = this.ensureTarget().depthTexture
    this.worldRenderer.blockEffects.setSunShadows(this.mode())
  }

  disable(): void {
    if (!this.enabled) return
    this.enabled = false
    this.worldRenderer.blockEffects.setSunShadows('off')
    this.disposeGpu()
  }

  autoEnableCheck(): boolean {
    return this.mode() !== 'off'
  }

  updateTimeOfDay(time: number): void {
    this.timeOfDay.update(time, performance.now())
  }

  render = (): void => {
    this.update(performance.now())
  }

  dispose(): void {
    this.disable()
  }

  /** Per frame, after the frame was drawn: the new map and its matrix take effect together on the next frame. */
  update(now: number): void {
    if (!this.enabled) return
    const effects = this.worldRenderer.blockEffects
    const mode = this.mode()
    if (mode === 'off') return
    effects.setSunShadows(mode)

    const cfg = this.worldRenderer.worldRendererConfig
    const hasSun = cfg.defaultSkybox && cfg.cardinalLight !== 'nether'
    sunDirectionFromTime(this.timeOfDay.get(now), this.sunDir)
    const strength = hasSun ? sunShadowStrength(this.sunDir.y) : 0
    const params = effects.uniforms.u_shadowParams.value
    if (strength <= 0 || this.worldRenderer.renderer.xr.isPresenting) {
      params.x = 0
      return
    }

    const distance = resolveShadowDistance(cfg.sunShadowsDistance)
    const focus = this.worldRenderer.cameraWorldPos
    const frame = computeShadowFrame({
      sunDir: this.sunDir,
      focus,
      renderOrigin: this.worldRenderer.chunkMeshManager.getRenderOrigin(),
      distance,
      mapSize: SHADOW_MAP_SIZE
    })
    const geometryVersion = this.geometryVersion()
    if (shadowNeedsRerender(this.lastRender, frame.key, this.sunDir, geometryVersion, now)) {
      this.renderMap(frame, focus, distance)
      this.lastRender = { key: frame.key, sunDir: this.sunDir.clone(), geometryVersion, renderedAt: now }
      this.applyFrameUniforms(frame, distance)
    }
    // Only the strength follows the sun every frame, the rest belongs to the rendered map.
    params.x = this.lastRender ? strength : 0
  }

  private mode(): SunShadowsMode {
    return this.worldRenderer.worldRendererConfig.sunShadows
  }

  private applyFrameUniforms(frame: ShadowFrame, distance: number): void {
    const u = this.worldRenderer.blockEffects.uniforms
    u.u_shadowMatrix.value.copy(frame.shadowMatrix)
    u.u_sunDir.value.copy(this.lastRender!.sunDir)
    u.u_shadowParams.value.set(0, 1 / SHADOW_MAP_SIZE, distance * 0.75, distance)
    // Depth is linear over frame.depthRange blocks.
    u.u_shadowBias.value.set((frame.texelWorld * 0.75) / frame.depthRange, (frame.texelWorld * 4) / frame.depthRange)
    u.u_shadowNormalOffset.value = frame.texelWorld * 1.5
  }

  private renderMap(frame: ShadowFrame, focus: { x: number; z: number }, distance: number): void {
    const { renderer } = this.worldRenderer
    const target = this.ensureTarget()
    this.worldRenderer.blockEffects.uniforms.u_shadowMap.value = target.depthTexture
    const include = (key: string) => {
      const pos = parseSectionKey(key)
      return pos !== undefined && sectionCastsIntoRange(pos[0], pos[2], { x: focus.x, y: 0, z: focus.z }, distance)
    }
    this.syncCasters(include)
    this.lightViewProj.value.copy(frame.lightViewProj)

    this.withTarget(target, () => renderer.render(this.shadowScene, this.shadowCamera))
    this.renderCount++
  }

  private clearMap(): void {
    const { renderer } = this.worldRenderer
    this.withTarget(this.ensureTarget(), () => renderer.clear())
  }

  /** Draw into the shadow target, leaving the renderer state as it was (render target, auto clear, XR). */
  private withTarget(target: THREE.WebGLRenderTarget, draw: () => void): void {
    const { renderer } = this.worldRenderer
    const previousTarget = renderer.getRenderTarget()
    const previousAutoClear = renderer.autoClear
    const previousXr = renderer.xr.enabled
    renderer.xr.enabled = false
    renderer.autoClear = true
    renderer.setRenderTarget(target)
    try {
      draw()
    } finally {
      renderer.setRenderTarget(previousTarget)
      renderer.autoClear = previousAutoClear
      renderer.xr.enabled = previousXr
    }
  }

  private ensureTarget(): THREE.WebGLRenderTarget {
    if (this.target) return this.target
    const depthTexture = new THREE.DepthTexture(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, THREE.UnsignedIntType)
    // Compare mode + linear filtering: every tap is a hardware 2x2 PCF.
    depthTexture.compareFunction = THREE.LessEqualCompare
    depthTexture.minFilter = THREE.LinearFilter
    depthTexture.magFilter = THREE.LinearFilter
    this.target = new THREE.WebGLRenderTarget(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, {
      // three always attaches a colour texture, keep it as small as possible
      format: THREE.RedFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: true,
      depthTexture
    })
    return this.target
  }

  private syncCasters(include: (key: string) => boolean): void {
    const manager = this.worldRenderer.chunkMeshManager
    const cubeBuffer = manager.globalBlockBuffer
    if (this.cubeCaster && this.cubeCaster.buffer !== cubeBuffer) this.removeCaster(this.cubeCaster)
    if (cubeBuffer) {
      if (!this.cubeCaster || this.cubeCaster.buffer !== cubeBuffer) {
        const material = createCubeShadowCasterMaterial(cubeBuffer.mesh.material, this.lightViewProj)
        const caster: Caster<GlobalBlockBuffer, CubeDrawSpan> = {
          buffer: cubeBuffer,
          material,
          mesh: this.createCasterMesh(cubeBuffer.mesh.geometry, material),
          spans: []
        }
        caster.mesh.onAfterRender = renderer => cubeBuffer.drawSpans(renderer, material, caster.spans)
        this.cubeCaster = caster
      }
      this.cubeCaster.mesh.geometry = cubeBuffer.mesh.geometry
      this.cubeCaster.spans = cubeBuffer.collectSectionSpans(include)
    } else {
      this.cubeCaster = undefined
    }

    const legacyBuffer = manager.globalLegacyBuffer
    if (this.legacyCaster && this.legacyCaster.buffer !== legacyBuffer) this.removeCaster(this.legacyCaster)
    if (legacyBuffer) {
      if (!this.legacyCaster || this.legacyCaster.buffer !== legacyBuffer) {
        const material = createGlobalLegacyShadowCasterMaterial(legacyBuffer.material, this.lightViewProj)
        const caster: Caster<GlobalLegacyBuffer, LegacyDrawSpan> = {
          buffer: legacyBuffer,
          material,
          mesh: this.createCasterMesh(legacyBuffer.mesh.geometry, material),
          spans: []
        }
        caster.mesh.onAfterRender = renderer => legacyBuffer.drawIndexSpans(renderer, caster.spans)
        this.legacyCaster = caster
      }
      this.legacyCaster.mesh.geometry = legacyBuffer.mesh.geometry
      this.legacyCaster.spans = legacyBuffer.collectSectionIndexSpans(include)
    } else {
      this.legacyCaster = undefined
    }
  }

  /** Shares the buffer geometry: three binds its attributes (the buffer keeps its own draw suppressed), onAfterRender draws the spans. */
  private createCasterMesh(geometry: THREE.BufferGeometry, material: THREE.ShaderMaterial): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    mesh.matrixAutoUpdate = false
    this.shadowScene.add(mesh)
    return mesh
  }

  private removeCaster(caster: Caster<unknown, unknown>): void {
    this.shadowScene.remove(caster.mesh)
    caster.material.dispose()
  }

  private geometryVersion(): string {
    const manager = this.worldRenderer.chunkMeshManager
    const describe = (buffer: GlobalBlockBuffer | GlobalLegacyBuffer | null) => {
      if (!buffer) return '-'
      let id = this.bufferIds.get(buffer)
      if (id === undefined) {
        id = this.nextBufferId++
        this.bufferIds.set(buffer, id)
      }
      return `${id}:${buffer.getLayoutVersion()}:${buffer.getUploadEpoch()}`
    }
    return `${describe(manager.globalBlockBuffer)}|${describe(manager.globalLegacyBuffer)}`
  }

  private disposeGpu(): void {
    if (this.cubeCaster) this.removeCaster(this.cubeCaster)
    if (this.legacyCaster) this.removeCaster(this.legacyCaster)
    this.cubeCaster = undefined
    this.legacyCaster = undefined
    this.target?.depthTexture?.dispose()
    this.target?.dispose()
    this.target = undefined
    this.lastRender = undefined
    const u = this.worldRenderer.blockEffects.uniforms
    u.u_shadowMap.value = null
    u.u_shadowParams.value.x = 0
  }
}

export const sunShadowsManifest: RendererModuleManifest = {
  id: 'sunShadows',
  controller: SunShadowsModule
}
