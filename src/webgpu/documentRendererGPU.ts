/**
 * WebGPU render loop.
 *
 * Per frame:
 *   1. reset the indirect draw's instanceCount
 *   2. upload any pending face/section edits (budgeted)
 *   3. dispatch the cull compute pass (frustum, + Hi-Z occlusion when enabled)
 *   4. render — a single `drawIndirect` covers every visible cube face in the world
 *
 * The CPU never builds a visible-span list and never varies the draw count, which is the
 * whole point: on the WebGL backend that work scaled with loaded sections and dominated
 * main-thread time on mobile.
 */

import * as THREE from 'three/webgpu'

import { GlobalBlockBufferGPU } from './globalBlockBufferGPU'
import { createCullCompute, createCullUniforms, createDrawArgs, resetDrawArgs, updateFrustumPlanes, CULL_WORKGROUP_SIZE } from './cullCompute'
import { createCubeBlockNodeMaterial, createCubeBlockUniforms, VERTICES_PER_FACE } from './shaders/cubeBlockNode'
import { GlobalLegacyBufferGPU, DRAW_VERTS_PER_QUAD } from './globalLegacyBufferGPU'
import { createLegacyBlockNodeMaterial, createLegacyBlockUniforms } from './shaders/legacyBlockNode'
import { detectWebGpuSupport, maxFacesForLimits, type WebGpuSupport } from './capabilities'

export type DocumentRendererGPUOptions = {
  canvas?: HTMLCanvasElement | OffscreenCanvas
  atlas: THREE.Texture
  tintPalette: THREE.Texture
  /** Disables the frustum cull in the compute pass; useful for parity checks. */
  disableCulling?: boolean
  antialias?: boolean
  /**
   * Opt-in rendering of non-full-block geometry (stairs, slabs, fences, models) via
   * `GlobalLegacyBufferGPU`. Off by default: it adds a second set of storage buffers and a
   * second indirect draw, and the cube path alone is the memory-safest configuration on iOS.
   */
  enableLegacyGeometry?: boolean
  /**
   * Opt-in transparent pass for blended geometry (water, glass, ice). Rendered after the
   * opaque passes with depth writes off. Implies a third storage buffer + indirect draw.
   */
  enableTransparency?: boolean
}

export type FrameStats = {
  cpuFrameMs: number
  visibleFaces: number
  usedFaces: number
  capacityFaces: number
  sectionCount: number
  uploadsPending: boolean
  /** Present only when `enableLegacyGeometry` is on. */
  legacy?: {
    visibleQuads: number
    usedQuads: number
    capacityQuads: number
    sectionCount: number
  }
  /** Present only when `enableTransparency` is on. */
  blend?: {
    visibleQuads: number
    usedQuads: number
    sectionCount: number
  }
}

export class DocumentRendererGPU {
  readonly renderer: THREE.WebGPURenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly blocks: GlobalBlockBufferGPU

  private readonly drawArgs: THREE.IndirectStorageBufferAttribute
  private readonly frustumPlanes: THREE.StorageBufferAttribute
  private readonly cullUniforms = createCullUniforms()
  private readonly cubeUniforms = createCubeBlockUniforms()
  private cullNode: any
  private cullDispatchSections = 0
  private readonly mesh: THREE.Mesh

  // --- opt-in non-full-block geometry ---
  readonly legacy: GlobalLegacyBufferGPU | undefined
  private readonly legacyDrawArgs: THREE.IndirectStorageBufferAttribute | undefined
  private readonly legacyUniforms = createLegacyBlockUniforms()
  private legacyCullNode: any
  private legacyCullSections = 0
  private readonly legacyMesh: THREE.Mesh | undefined

  // --- opt-in transparent (blended) geometry ---
  readonly blend: GlobalLegacyBufferGPU | undefined
  private readonly blendDrawArgs: THREE.IndirectStorageBufferAttribute | undefined
  private readonly blendUniforms = createLegacyBlockUniforms()
  private blendCullNode: any
  private blendCullSections = 0
  private readonly blendMesh: THREE.Mesh | undefined

  private animationFrameId?: number
  private disposed = false
  private lastStats: FrameStats = {
    cpuFrameMs: 0,
    visibleFaces: 0,
    usedFaces: 0,
    capacityFaces: 0,
    sectionCount: 0,
    uploadsPending: false
  }

  support: WebGpuSupport | undefined

  private constructor(renderer: THREE.WebGPURenderer, blocks: GlobalBlockBufferGPU, opts: DocumentRendererGPUOptions) {
    this.renderer = renderer
    this.blocks = blocks

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 10_000)

    this.drawArgs = createDrawArgs(VERTICES_PER_FACE)
    this.frustumPlanes = new THREE.StorageBufferAttribute(new Float32Array(6 * 4), 4)

    const { material } = createCubeBlockNodeMaterial(
      {
        faceWords: blocks.faceWords,
        visibleFaces: blocks.visibleFaces,
        atlas: opts.atlas,
        tintPalette: opts.tintPalette
      },
      this.cubeUniforms
    )

    // 6 non-indexed verts; instanceCount comes from the indirect buffer, so the geometry
    // itself carries no per-instance attributes at all.
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(VERTICES_PER_FACE * 3), 3))
    geometry.setDrawRange(0, VERTICES_PER_FACE)
    geometry.setIndirect(this.drawArgs)

    this.mesh = new THREE.Mesh(geometry, material)
    this.mesh.name = 'globalShaderCubesGPU'
    this.mesh.frustumCulled = false
    this.mesh.matrixAutoUpdate = false
    this.scene.add(this.mesh)

    if (opts.enableLegacyGeometry) {
      this.legacy = new GlobalLegacyBufferGPU()
      this.legacyDrawArgs = createDrawArgs(DRAW_VERTS_PER_QUAD)

      const { material: legacyMaterial } = createLegacyBlockNodeMaterial(
        {
          positions: this.legacy.positions,
          uvs: this.legacy.uvs,
          colors: this.legacy.colors,
          skyLights: this.legacy.skyLights,
          blockLights: this.legacy.blockLights,
          quadMeta: this.legacy.quadMeta,
          sectionMeta: this.legacy.sectionMeta,
          visibleQuads: this.legacy.visibleQuads,
          atlas: opts.atlas
        },
        this.legacyUniforms
      )

      const legacyGeometry = new THREE.BufferGeometry()
      legacyGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DRAW_VERTS_PER_QUAD * 3), 3))
      legacyGeometry.setDrawRange(0, DRAW_VERTS_PER_QUAD)
      legacyGeometry.setIndirect(this.legacyDrawArgs)

      this.legacyMesh = new THREE.Mesh(legacyGeometry, legacyMaterial)
      this.legacyMesh.name = 'globalLegacyGPU'
      this.legacyMesh.frustumCulled = false
      this.legacyMesh.matrixAutoUpdate = false
      this.scene.add(this.legacyMesh)
    }

    if (opts.enableTransparency) {
      // Same class, same cull pass — only the material differs.
      this.blend = new GlobalLegacyBufferGPU()
      this.blendDrawArgs = createDrawArgs(DRAW_VERTS_PER_QUAD)

      const { material: blendMaterial } = createLegacyBlockNodeMaterial(
        {
          positions: this.blend.positions,
          uvs: this.blend.uvs,
          colors: this.blend.colors,
          skyLights: this.blend.skyLights,
          blockLights: this.blend.blockLights,
          quadMeta: this.blend.quadMeta,
          sectionMeta: this.blend.sectionMeta,
          visibleQuads: this.blend.visibleQuads,
          atlas: opts.atlas
        },
        this.blendUniforms,
        { transparent: true }
      )

      const blendGeometry = new THREE.BufferGeometry()
      blendGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DRAW_VERTS_PER_QUAD * 3), 3))
      blendGeometry.setDrawRange(0, DRAW_VERTS_PER_QUAD)
      blendGeometry.setIndirect(this.blendDrawArgs)

      this.blendMesh = new THREE.Mesh(blendGeometry, blendMaterial)
      this.blendMesh.name = 'globalBlendGPU'
      this.blendMesh.frustumCulled = false
      this.blendMesh.matrixAutoUpdate = false
      // Draw after both opaque passes have filled the depth buffer.
      this.blendMesh.renderOrder = 10
      this.scene.add(this.blendMesh)
    }

    this.cullUniforms.frustumCullEnabled.value = opts.disableCulling ? 0 : 1
    this.rebuildCullDispatch()
  }

  static async create(opts: DocumentRendererGPUOptions): Promise<DocumentRendererGPU> {
    const support = await detectWebGpuSupport()
    if (!support.supported) {
      throw new Error(`WebGPU unavailable: ${support.reason}`)
    }

    const renderer = new THREE.WebGPURenderer({
      canvas: opts.canvas as HTMLCanvasElement,
      antialias: opts.antialias ?? false,
      forceWebGL: false
    })
    await renderer.init()

    // Clamp capacity to what this adapter can actually bind, so growth fails predictably
    // instead of the device being lost mid-session (the iOS failure mode).
    const blocks = new GlobalBlockBufferGPU({ maxCapacityFaces: maxFacesForLimits(support.limits) })

    const instance = new DocumentRendererGPU(renderer, blocks, opts)
    instance.support = support
    return instance
  }

  /**
   * The cull dispatch covers every section slot in use — one workgroup each. Rebuilt only
   * when that count changes, since building the node recompiles the compute pipeline.
   */
  private rebuildCullDispatch(): void {
    const sections = Math.max(1, this.blocks.sectionDispatchCount)
    if (sections === this.cullDispatchSections && this.cullNode) return
    this.cullDispatchSections = sections

    const { dispatchFor } = createCullCompute(
      {
        sectionMeta: this.blocks.sectionMeta,
        visibleFaces: this.blocks.visibleFaces,
        drawArgs: this.drawArgs,
        frustumPlanes: this.frustumPlanes
      },
      this.cullUniforms
    )
    this.cullNode = dispatchFor(sections)
  }

  /**
   * The legacy cull reuses `createCullCompute` unchanged — it compacts "N items owned by a
   * section", and a quad is as valid an item as a cube face.
   */
  private rebuildLegacyCullDispatch(): void {
    if (!this.legacy || !this.legacyDrawArgs) return
    const sections = Math.max(1, this.legacy.sectionDispatchCount)
    if (sections === this.legacyCullSections && this.legacyCullNode) return
    this.legacyCullSections = sections

    const { dispatchFor } = createCullCompute(
      {
        sectionMeta: this.legacy.sectionMeta,
        visibleFaces: this.legacy.visibleQuads,
        drawArgs: this.legacyDrawArgs,
        frustumPlanes: this.frustumPlanes
      },
      this.cullUniforms
    )
    this.legacyCullNode = dispatchFor(sections)
  }

  private rebuildBlendCullDispatch(): void {
    if (!this.blend || !this.blendDrawArgs) return
    const sections = Math.max(1, this.blend.sectionDispatchCount)
    if (sections === this.blendCullSections && this.blendCullNode) return
    this.blendCullSections = sections

    const { dispatchFor } = createCullCompute(
      {
        sectionMeta: this.blend.sectionMeta,
        visibleFaces: this.blend.visibleQuads,
        drawArgs: this.blendDrawArgs,
        frustumPlanes: this.frustumPlanes
      },
      this.cullUniforms
    )
    this.blendCullNode = dispatchFor(sections)
  }

  setSize(width: number, height: number, pixelRatio = 1): void {
    this.renderer.setPixelRatio(pixelRatio)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  /**
   * Camera-relative origin. Mirrors the WebGL path: the integer section origin and the
   * fractional remainder are kept apart so float32 never has to represent world coords.
   */
  setCameraOrigin(sectionOriginRel: THREE.Vector3, originDelta: THREE.Vector3, cameraOriginFrac: THREE.Vector3): void {
    this.cubeUniforms.sectionOriginRel.value.copy(sectionOriginRel)
    this.cubeUniforms.originDelta.value.copy(originDelta)
    this.cubeUniforms.cameraOriginFrac.value.copy(cameraOriginFrac)
    this.cullUniforms.sectionOriginRel.value.copy(sectionOriginRel)
    this.cullUniforms.originDelta.value.copy(originDelta)
    this.cullUniforms.cameraOriginFrac.value.copy(cameraOriginFrac)
    for (const u of [this.legacyUniforms, this.blendUniforms]) {
      u.sectionOriginRel.value.copy(sectionOriginRel)
      u.originDelta.value.copy(originDelta)
      u.cameraOriginFrac.value.copy(cameraOriginFrac)
    }
  }

  setSkyLevel(value: number): void {
    this.cubeUniforms.skyLevel.value = value
    this.legacyUniforms.skyLevel.value = value
    this.blendUniforms.skyLevel.value = value
  }

  setDebugMode(mode: number): void {
    this.cubeUniforms.debugMode.value = mode
  }

  setFog(color: THREE.Color | null, near = 1, far = 1000): void {
    this.cubeUniforms.fogEnabled.value = color ? 1 : 0
    this.legacyUniforms.fogEnabled.value = color ? 1 : 0
    if (color) {
      this.cubeUniforms.fogColor.value.copy(color)
      this.cubeUniforms.fogNear.value = near
      this.cubeUniforms.fogFar.value = far
      this.legacyUniforms.fogColor.value.copy(color)
      this.legacyUniforms.fogNear.value = near
      this.legacyUniforms.fogFar.value = far
    }
  }

  async renderFrame(): Promise<FrameStats> {
    if (this.disposed) return this.lastStats
    const t0 = performance.now()

    this.camera.updateMatrixWorld()

    const uploadsPending = this.blocks.flushUploads()
    this.legacy?.flushUploads()
    this.blend?.flushUploads()
    this.rebuildCullDispatch()
    this.rebuildLegacyCullDispatch()
    this.rebuildBlendCullDispatch()

    resetDrawArgs(this.drawArgs)
    if (this.legacyDrawArgs) resetDrawArgs(this.legacyDrawArgs)
    if (this.blendDrawArgs) resetDrawArgs(this.blendDrawArgs)
    updateFrustumPlanes(this.frustumPlanes, this.camera)

    // Cull first: the render pass consumes the instanceCounts these write.
    await this.renderer.computeAsync(this.cullNode)
    if (this.legacyCullNode) await this.renderer.computeAsync(this.legacyCullNode)
    if (this.blendCullNode) await this.renderer.computeAsync(this.blendCullNode)
    await this.renderer.renderAsync(this.scene, this.camera)

    this.lastStats = {
      cpuFrameMs: performance.now() - t0,
      visibleFaces: (this.drawArgs.array as Uint32Array)[1] ?? 0,
      usedFaces: this.blocks.usedFaces,
      capacityFaces: this.blocks.capacity,
      sectionCount: this.blocks.sectionCount,
      uploadsPending,
      legacy: this.legacy
        ? {
            visibleQuads: (this.legacyDrawArgs?.array as Uint32Array | undefined)?.[1] ?? 0,
            usedQuads: this.legacy.usedQuads,
            capacityQuads: this.legacy.capacity,
            sectionCount: this.legacy.sectionCount
          }
        : undefined,
      blend: this.blend
        ? {
            visibleQuads: (this.blendDrawArgs?.array as Uint32Array | undefined)?.[1] ?? 0,
            usedQuads: this.blend.usedQuads,
            sectionCount: this.blend.sectionCount
          }
        : undefined
    }
    return this.lastStats
  }

  startLoop(onFrame?: (stats: FrameStats) => void): void {
    const tick = () => {
      if (this.disposed) return
      this.animationFrameId = requestAnimationFrame(tick)
      void this.renderFrame().then(stats => onFrame?.(stats))
    }
    this.animationFrameId = requestAnimationFrame(tick)
  }

  stopLoop(): void {
    if (this.animationFrameId !== undefined) cancelAnimationFrame(this.animationFrameId)
    this.animationFrameId = undefined
  }

  get stats(): FrameStats {
    return this.lastStats
  }

  dispose(): void {
    this.disposed = true
    this.stopLoop()
    this.blocks.dispose()
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    this.legacy?.dispose()
    this.legacyMesh?.geometry.dispose()
    ;(this.legacyMesh?.material as THREE.Material | undefined)?.dispose()
    this.blend?.dispose()
    this.blendMesh?.geometry.dispose()
    ;(this.blendMesh?.material as THREE.Material | undefined)?.dispose()
    this.renderer.dispose()
  }
}
