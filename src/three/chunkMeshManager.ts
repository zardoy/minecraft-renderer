import PrismarineChatLoader from 'prismarine-chat'
import * as THREE from 'three'
import * as nbt from 'prismarine-nbt'
import { Vec3 } from 'vec3'
import { MesherGeometryOutput } from '../mesher-shared/shared'
import { getShaderCubeResources, SHADER_CUBES_WORDS_PER_FACE } from '../wasm-mesher/bridge/shaderCubeBridge'
import { createCubeBlockMaterial } from './shaders/cubeBlockShader'
import { createGlobalLegacyBlendMaterial, createGlobalLegacyBlockMaterial, createLegacyBlockMaterial, setLegacyCameraOrigin } from './shaders/legacyBlockShader'
import { LEGACY_SECTION_HALF_EXTENT, sectionIntersectsFrustum, setupLegacySectionMatrix, updateLegacySectionCullState } from './legacySectionCull'
import { createShaderCubeMesh, disposeShaderCubeMesh } from './shaderCubeMesh'
import { GlobalBlockBuffer } from './globalBlockBuffer'
import { GlobalLegacyBuffer, type LegacySectionGeometry } from './globalLegacyBuffer'
import {
  computeShaderSectionRaycastAabb,
  isPointInsideAabb,
  raycastAabb,
  raycastShaderBlocksAabb,
  sectionAabbIntersectsRay,
  type ShaderSectionRaycastEntry,
} from './sectionRaycastAabb'
import { chunkPos } from '../lib/simpleUtils'
import { renderSign } from '../sign-renderer'
import { getMesh } from './entity/EntityMesh'
import type { WorldRendererThree } from './worldRendererThree'
import { armorModel } from './entity/armorModels'
import { disposeObject } from './threeJsUtils'
import { getBannerTexture, createBannerMesh, releaseBannerTexture } from './bannerRenderer'

export interface ChunkMeshPool {
  mesh: THREE.Mesh
  inUse: boolean
  lastUsedTime: number
  sectionKey?: string
}

export interface SectionObject extends THREE.Group {
  mesh?: THREE.Mesh<THREE.BufferGeometry, THREE.Material>
  /** Per-section instanced shader mesh (sci-fi reveal defer only). */
  shaderMesh?: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>
  /** Shader cube words kept for migration to global buffer after reveal. */
  deferredShaderCubes?: { words: Uint32Array, count: number }
  /** Opaque legacy geometry deferred from global buffer during sci-fi reveal. */
  deferredLegacyOpaque?: LegacySectionGeometry
  /** Blend legacy geometry deferred from global buffer during sci-fi reveal. */
  deferredLegacyBlend?: LegacySectionGeometry
  /** Section uses a pooled mesh for blend (reveal defer or invariant fallback). */
  hasBlendMesh?: boolean
  tilesCount?: number
  blocksCount?: number

  signsContainer?: THREE.Group
  headsContainer?: THREE.Group
  bannersContainer?: THREE.Group
  boxHelper?: THREE.BoxHelper
  /**
   * World-space coordinates of the section origin. Cached so that
   * {@link ChunkMeshManager.updateBoxHelper} can position lazily-created
   * border helpers correctly under camera-relative rendering, where
   * `mesh.position` is proxied to (world - sceneOrigin) and cannot be
   * reused directly for objects that are tracked separately.
   */
  worldX?: number
  worldY?: number
  worldZ?: number
  foutain?: boolean
  /**
   * True while the section is held invisible by the "Batch Chunks Display"
   * (`_renderByChunks`) feature, waiting for the parent chunk to finish meshing
   * before being shown together with the rest of the chunk.
   */
  _waitingForChunkDisplay?: boolean
}

export class ChunkMeshManager {
  private readonly meshPool: ChunkMeshPool[] = []
  private readonly activeSections = new Map<string, ChunkMeshPool>()
  readonly sectionObjects: Record<string, SectionObject> = {}
  /**
   * Sections kept invisible because the "Batch Chunks Display" option is on
   * and their parent chunk hasn't finished meshing yet. Keyed by chunk key
   * (`x,z`); flushed by `WorldRendererThree.finishChunk(chunkKey)`.
   */
  readonly waitingChunksToDisplay: Record<string, string[]> = {}
  /**
   * Chunks whose mesh batch is fully ready but kept invisible by the
   * WASM near-first reveal gate because at least one nearer column is
   * not yet finished. Value = enqueue timestamp (ms), used by the
   * expected-delivery grace window in `isBlockedByNearer`.
   */
  readonly pendingNearReveal = new Map<string, number>()
  private readonly nearRevealTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly nearRevealGraceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // Force-flush pending reveal after this many ms (last-resort safety).
  private static readonly NEAR_REVEAL_TIMEOUT_MS = 5000
  // Soft window during which the gate also waits for *expected* nearer
  // columns that have not arrived yet (covers far-worker-beats-near-worker).
  private static readonly EXPECTED_NEAR_GRACE_MS = 1500
  private poolSize!: number
  private maxPoolSize!: number
  private minPoolSize!: number
  private readonly signHeadsRenderer: SignHeadsRenderer
  /**
   * Shared transparent material used as the basis for the wireframe chunk
   * border `BoxHelper` created lazily in {@link updateBoxHelper}. Kept on the
   * manager so the BoxHelper machinery doesn't allocate a new material per
   * section.
   */
  private readonly chunkBoxMaterial = new THREE.MeshBasicMaterial({ color: 0x00_00_00, transparent: true, opacity: 0 })
  /** Shared across all sections — atlas/tint uniforms updated via {@link syncCubeShaderUniforms}. */
  private cubeShaderMaterial: THREE.ShaderMaterial | null = null
  /** Per-section blend meshes — atlas + camera origin updated each frame. */
  private legacyShaderMaterial: THREE.ShaderMaterial | null = null
  private globalLegacyShaderMaterial: THREE.ShaderMaterial | null = null
  private globalLegacyBlendShaderMaterial: THREE.ShaderMaterial | null = null
  private readonly _legacyCullFrustum = new THREE.Frustum()
  private readonly _legacyCullProjScreen = new THREE.Matrix4()
  private readonly _legacyCullBox = new THREE.Box3()
  private readonly _legacyCullBoxMin = new THREE.Vector3()
  private readonly _legacyCullBoxMax = new THREE.Vector3()
  private readonly _visibleSectionSpans: Array<{ key: string, distSq: number }> = []
  /** One instanced mesh for all shader-cube faces (single draw call). */
  globalBlockBuffer: GlobalBlockBuffer | null = null
  globalLegacyBuffer: GlobalLegacyBuffer | null = null
  globalLegacyBlendBuffer: GlobalLegacyBuffer | null = null
  /** Tight world AABBs for third-person raycast; block word0 read from GlobalBlockBuffer or deferred. */
  private readonly shaderSectionRaycastBoxes = new Map<string, ShaderSectionRaycastEntry>()
  /** Per-raycast block dedup; safe while the eye is inside at most one section aggregate AABB per call. */
  private readonly blockRaycastVisitGen = new Uint16Array(4096)
  private blockRaycastVisitStamp = 1

  // Performance tracking
  private hits = 0
  private misses = 0

  // Debug flag to bypass pooling
  public bypassPooling = false

  // Performance monitoring
  private readonly renderTimes: number[] = []
  private readonly maxRenderTimeSamples = 30
  private _performanceOverrideDistance?: number
  private lastPerformanceCheck = 0
  private readonly performanceCheckInterval = 2000 // Check every 2 seconds

  get performanceOverrideDistance () {
    return this._performanceOverrideDistance ?? 0
  }
  set performanceOverrideDistance (value: number | undefined) {
    this._performanceOverrideDistance = value
    this.updateSectionsVisibility()
  }

  constructor (
    public worldRenderer: WorldRendererThree,
    public scene: THREE.Object3D,
    public material: THREE.Material,
    public worldHeight: number,
    viewDistance = 3,
  ) {
    this.updateViewDistance(viewDistance)
    this.signHeadsRenderer = new SignHeadsRenderer(worldRenderer)

    this.initializePool()
  }

  private initializePool () {
    // Create initial pool
    for (let i = 0; i < this.poolSize; i++) {
      const geometry = new THREE.BufferGeometry()
      const mesh = new THREE.Mesh(geometry, this.getLegacyShaderMaterial())
      mesh.visible = false
      mesh.matrixAutoUpdate = false
      mesh.name = 'pooled-section-mesh'

      const poolEntry: ChunkMeshPool = {
        mesh,
        inUse: false,
        lastUsedTime: 0
      }

      this.meshPool.push(poolEntry)
      // Don't add to scene here - meshes will be added to containers
    }
  }

  /** True when section has legacy vertices and/or GPU shader cube instances. */
  sectionHasRenderableContent (geometryData: MesherGeometryOutput): boolean {
    if (geometryData.positions.length > 0) return true
    if ((geometryData.blend?.positions.length ?? 0) > 0) return true
    if (!this.isShaderCubesGpuEnabled()) return false
    return (geometryData.shaderCubes?.count ?? 0) > 0
  }

  isShaderCubesGpuEnabled (): boolean {
    return this.worldRenderer.shaderCubeBlocksEnabled()
  }

  syncCubeShaderUniforms (): void {
    if (!this.isShaderCubesGpuEnabled()) return
    const mat = this.cubeShaderMaterial ?? this.getCubeShaderMaterial()
    if (!mat) return
    const atlas = (this.material as THREE.MeshBasicMaterial).map ?? null
    mat.uniforms.u_atlas.value = atlas
    const resources = getShaderCubeResources()
    if (!resources) return
    const { tintPalette } = resources
    if (!tintPalette.isReady()) {
      tintPalette.createTexture()
    }
    mat.uniforms.u_tintPalette.value = tintPalette.getTexture()
    mat.uniforms.u_debugMode.value = this.worldRenderer.worldRendererConfig.shaderCubeDebugMode ?? 0
    mat.needsUpdate = true
  }

  syncLegacyShaderUniforms (): void {
    const atlas = (this.material as THREE.MeshBasicMaterial).map ?? null
    if (this.legacyShaderMaterial) {
      this.legacyShaderMaterial.uniforms.u_atlas.value = atlas
      this.legacyShaderMaterial.needsUpdate = true
    }
    if (this.globalLegacyShaderMaterial) {
      this.globalLegacyShaderMaterial.uniforms.u_atlas.value = atlas
      this.globalLegacyShaderMaterial.needsUpdate = true
    }
    if (this.globalLegacyBlendShaderMaterial) {
      this.globalLegacyBlendShaderMaterial.uniforms.u_atlas.value = atlas
      this.globalLegacyBlendShaderMaterial.needsUpdate = true
    }
  }

  private getLegacyShaderMaterial (): THREE.ShaderMaterial {
    if (!this.legacyShaderMaterial) {
      this.legacyShaderMaterial = createLegacyBlockMaterial()
      this.syncLegacyShaderUniforms()
    }
    return this.legacyShaderMaterial
  }

  private getGlobalLegacyShaderMaterial (): THREE.ShaderMaterial {
    if (!this.globalLegacyShaderMaterial) {
      this.globalLegacyShaderMaterial = createGlobalLegacyBlockMaterial()
      this.syncLegacyShaderUniforms()
    }
    return this.globalLegacyShaderMaterial
  }

  private getGlobalLegacyBuffer (): GlobalLegacyBuffer {
    if (!this.globalLegacyBuffer) {
      this.globalLegacyBuffer = new GlobalLegacyBuffer(
        this.getGlobalLegacyShaderMaterial(),
        this.scene,
      )
    }
    return this.globalLegacyBuffer
  }

  private getGlobalLegacyBlendShaderMaterial (): THREE.ShaderMaterial {
    if (!this.globalLegacyBlendShaderMaterial) {
      this.globalLegacyBlendShaderMaterial = createGlobalLegacyBlendMaterial()
      this.syncLegacyShaderUniforms()
    }
    return this.globalLegacyBlendShaderMaterial
  }

  private getGlobalLegacyBlendBuffer (): GlobalLegacyBuffer {
    if (!this.globalLegacyBlendBuffer) {
      this.globalLegacyBlendBuffer = new GlobalLegacyBuffer(
        this.getGlobalLegacyBlendShaderMaterial(),
        this.scene,
        {
          name: 'globalLegacyBlend',
          initialCapacityQuads: 32_000,
          growthIncrementQuads: 32_000,
        },
      )
    }
    return this.globalLegacyBlendBuffer
  }

  /** Whether a section still holds a pooled legacy mesh (defer / invariant fallback). */
  sectionUsesPooledLegacyMesh (sectionKey: string): boolean {
    return this.activeSections.has(sectionKey)
  }

  /**
   * Shared section visibility + span groups for global legacy buffers.
   * Visible list is also the T3-ready interface for cube-buffer draw culling (not wired here).
   */
  updateLegacySectionCullAndSort (camera: THREE.Camera, cameraWorldX: number, cameraWorldY: number, cameraWorldZ: number): void {
    this._legacyCullProjScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    this._legacyCullFrustum.setFromProjectionMatrix(this._legacyCullProjScreen)

    const visible = this._visibleSectionSpans
    visible.length = 0

    for (const [sectionKey, sectionObject] of Object.entries(this.sectionObjects)) {
      if (sectionObject.worldX === undefined || !sectionObject.visible) continue
      const { visible: inFrustum, distSq } = sectionIntersectsFrustum(
        sectionObject.worldX,
        sectionObject.worldY ?? 0,
        sectionObject.worldZ ?? 0,
        cameraWorldX,
        cameraWorldY,
        cameraWorldZ,
        this._legacyCullFrustum,
        this._legacyCullBox,
        this._legacyCullBoxMin,
        this._legacyCullBoxMax,
      )
      if (inFrustum) {
        visible.push({ key: sectionKey, distSq })
      }
    }

    this.globalLegacyBuffer?.updateDrawSpans(visible, 'opaque')
    this.globalLegacyBlendBuffer?.updateDrawSpans(visible, 'sortedBlend')

    for (const poolEntry of this.activeSections.values()) {
      const sectionKey = poolEntry.sectionKey
      if (!sectionKey) continue
      const sectionObject = this.sectionObjects[sectionKey]
      if (!sectionObject) continue

      updateLegacySectionCullState(
        poolEntry.mesh,
        sectionObject.worldX ?? 0,
        sectionObject.worldY ?? 0,
        sectionObject.worldZ ?? 0,
        cameraWorldX,
        cameraWorldY,
        cameraWorldZ,
        this._legacyCullFrustum,
        this._legacyCullBox,
        this._legacyCullBoxMin,
        this._legacyCullBoxMax,
      )
    }
  }

  setLegacyCameraOrigin (x: number, y: number, z: number): void {
    setLegacyCameraOrigin(this.getLegacyShaderMaterial(), x, y, z)
    setLegacyCameraOrigin(this.getGlobalLegacyShaderMaterial(), x, y, z)
    setLegacyCameraOrigin(this.getGlobalLegacyBlendShaderMaterial(), x, y, z)
    this.globalLegacyBuffer?.setCameraOrigin(x, y, z)
    this.globalLegacyBlendBuffer?.setCameraOrigin(x, y, z)
  }

  private getCubeShaderMaterial (): THREE.ShaderMaterial | null {
    if (!this.isShaderCubesGpuEnabled()) return null
    if (!this.cubeShaderMaterial) {
      this.cubeShaderMaterial = createCubeBlockMaterial()
      this.syncCubeShaderUniforms()
    }
    return this.cubeShaderMaterial
  }

  private getGlobalBlockBuffer (): GlobalBlockBuffer | null {
    const mat = this.getCubeShaderMaterial()
    if (!mat) return null
    if (!this.globalBlockBuffer) {
      this.globalBlockBuffer = new GlobalBlockBuffer(mat, this.scene)
    }
    return this.globalBlockBuffer
  }

  private shouldDeferLegacyOpaqueToPerSection (sectionKey: string): boolean {
    return this.shouldDeferShaderToPerSection(sectionKey)
  }

  /** Sci-fi reveal needs per-section shader meshes (or no global add) until the first wave completes. */
  private shouldDeferShaderToPerSection (sectionKey: string): boolean {
    const sciFi = this.worldRenderer.getModule<{
      shouldUseRevealEffect?: (key: string) => boolean
      isInInitialRevealCampaign?: () => boolean
    }>('futuristicReveal')
    if (!sciFi) return false
    if (sciFi.isInInitialRevealCampaign?.()) return true
    return sciFi.shouldUseRevealEffect?.(sectionKey) === true
  }

  /**
   * Move deferred per-section shader cubes into the global buffer after reveal completes.
   */
  migrateDeferredShaderToGlobal (sectionKey: string): void {
    const section = this.sectionObjects[sectionKey]
    if (!section?.deferredShaderCubes) return

    const { words, count } = section.deferredShaderCubes
    const wx = section.worldX
    const wy = section.worldY
    const wz = section.worldZ

    if (wx !== undefined && wy !== undefined && wz !== undefined) {
      this.registerShaderSectionRaycastBox(sectionKey, words, count, wx, wy, wz)
    }

    const global = this.getGlobalBlockBuffer()
    global?.addSection(sectionKey, words, count)

    const hadShaderAsPrimary = section.mesh === (section.shaderMesh as unknown as THREE.Mesh | undefined)
    if (section.shaderMesh) {
      disposeShaderCubeMesh(section.shaderMesh)
      section.remove(section.shaderMesh)
      section.shaderMesh = undefined
    }
    delete section.deferredShaderCubes

    if (hadShaderAsPrimary) {
      section.mesh = undefined
    }
  }

  /**
   * Move deferred per-section opaque legacy into the global buffer after reveal completes.
   */
  migrateDeferredLegacyToGlobal (sectionKey: string): void {
    const section = this.sectionObjects[sectionKey]
    if (!section) return

    if (section.deferredLegacyOpaque) {
      const { positions, colors, uvs, indices } = section.deferredLegacyOpaque
      const wx = section.worldX
      const wy = section.worldY
      const wz = section.worldZ
      if (wx !== undefined && wy !== undefined && wz !== undefined) {
        this.getGlobalLegacyBuffer().addSection(
          sectionKey,
          { positions, colors, uvs, indices },
          wx,
          wy,
          wz,
        )
      }
      delete section.deferredLegacyOpaque
    }

    if (section.deferredLegacyBlend) {
      const { positions, colors, uvs, indices } = section.deferredLegacyBlend
      const wx = section.worldX
      const wy = section.worldY
      const wz = section.worldZ
      if (wx !== undefined && wy !== undefined && wz !== undefined) {
        this.getGlobalLegacyBlendBuffer().addSection(
          sectionKey,
          { positions, colors, uvs, indices },
          wx,
          wy,
          wz,
        )
      }
      delete section.deferredLegacyBlend
      section.hasBlendMesh = false
    }

    if (!section.hasBlendMesh) {
      const hadLegacyAsPrimary = section.mesh === this.activeSections.get(sectionKey)?.mesh
      this.releasePooledMesh(sectionKey)
      if (hadLegacyAsPrimary) {
        section.mesh = section.shaderMesh as unknown as THREE.Mesh | undefined ?? undefined
      }
    }
  }

  raycastGlobalLegacySections (
    raycaster: THREE.Raycaster,
    origin: THREE.Vector3,
    maxCenterDistance: number,
  ): number | undefined {
    const maxDistSq = maxCenterDistance * maxCenterDistance
    const dirX = raycaster.ray.direction.x
    const dirY = raycaster.ray.direction.y
    const dirZ = raycaster.ray.direction.z
    const far = raycaster.far
    const halfExtent = LEGACY_SECTION_HALF_EXTENT + 0.01
    const candidates: string[] = []
    for (const [key, section] of Object.entries(this.sectionObjects)) {
      if (section.worldX === undefined) continue
      const dx = section.worldX - origin.x
      const dy = (section.worldY ?? 0) - origin.y
      const dz = (section.worldZ ?? 0) - origin.z
      if (dx * dx + dy * dy + dz * dz > maxDistSq) continue
      const inOpaque = this.globalLegacyBuffer?.hasSection(key) ?? false
      const inBlend = this.globalLegacyBlendBuffer?.hasSection(key) ?? false
      if (!inOpaque && !inBlend) continue
      if (!sectionAabbIntersectsRay(
        section.worldX,
        section.worldY ?? 0,
        section.worldZ ?? 0,
        origin.x,
        origin.y,
        origin.z,
        dirX,
        dirY,
        dirZ,
        far,
        halfExtent,
      )) continue
      candidates.push(key)
    }

    if (candidates.length === 0) return undefined

    const hits: THREE.Intersection[] = []
    this.globalLegacyBuffer?.raycastSections(raycaster, candidates, hits)
    this.globalLegacyBlendBuffer?.raycastSections(raycaster, candidates, hits)

    return hits[0]?.distance
  }

  registerShaderSectionRaycastBox (
    sectionKey: string,
    words: Uint32Array,
    faceCount: number,
    sectionCenterX: number,
    sectionCenterY: number,
    sectionCenterZ: number,
  ): void {
    const box = computeShaderSectionRaycastAabb(words, faceCount, sectionCenterX, sectionCenterY, sectionCenterZ)
    if (box) {
      this.shaderSectionRaycastBoxes.set(sectionKey, {
        box,
        sectionCenterX,
        sectionCenterY,
        sectionCenterZ,
      })
    } else {
      this.shaderSectionRaycastBoxes.delete(sectionKey)
    }
  }

  unregisterShaderSectionRaycastBox (sectionKey: string): void {
    this.shaderSectionRaycastBoxes.delete(sectionKey)
  }

  /** Closest hit against registered shader-cube AABBs (world-space ray). */
  raycastShaderSectionAABBs (
    originWorld: THREE.Vector3,
    direction: THREE.Vector3,
    maxDist: number,
    maxCenterDistance = 80,
  ): number | undefined {
    const ox = originWorld.x
    const oy = originWorld.y
    const oz = originWorld.z
    const dx = direction.x
    const dy = direction.y
    const dz = direction.z
    const maxCenterDistSq = maxCenterDistance * maxCenterDistance

    let closest = maxDist
    let found = false

    this.blockRaycastVisitStamp++
    if (this.blockRaycastVisitStamp >= 65535) {
      this.blockRaycastVisitGen.fill(0)
      this.blockRaycastVisitStamp = 1
    }

    for (const [key, entry] of this.shaderSectionRaycastBoxes) {
      const section = this.sectionObjects[key]
      if (section && !section.visible) continue

      const { box } = entry
      const dcx = box.cx - ox
      const dcy = box.cy - oy
      const dcz = box.cz - oz
      if (dcx * dcx + dcy * dcy + dcz * dcz > maxCenterDistSq) continue

      let t = raycastAabb(
        ox, oy, oz, dx, dy, dz,
        box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ,
        closest,
      )
      if (t === undefined && isPointInsideAabb(ox, oy, oz, box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ)) {
        const gb = this.globalBlockBuffer
        const slot = gb?.getSectionSlot(key)
        if (gb && slot) {
          t = raycastShaderBlocksAabb(
            gb.getW0(),
            slot.start,
            slot.count,
            1,
            entry.sectionCenterX,
            entry.sectionCenterY,
            entry.sectionCenterZ,
            ox, oy, oz, dx, dy, dz,
            closest,
            this.blockRaycastVisitGen,
            this.blockRaycastVisitStamp,
          )
        } else {
          const def = this.sectionObjects[key]?.deferredShaderCubes
          if (def) {
            t = raycastShaderBlocksAabb(
              def.words,
              0,
              def.count,
              SHADER_CUBES_WORDS_PER_FACE,
              entry.sectionCenterX,
              entry.sectionCenterY,
              entry.sectionCenterZ,
              ox, oy, oz, dx, dy, dz,
              closest,
              this.blockRaycastVisitGen,
              this.blockRaycastVisitStamp,
            )
          }
        }
      }
      if (t !== undefined && t < closest) {
        closest = t
        found = true
      }
    }

    return found ? closest : undefined
  }

  /**
   * Update or create a section with new geometry data
   */
  private uploadLegacyPooledMesh (
    poolEntry: ChunkMeshPool,
    geometryData: MesherGeometryOutput | MesherGeometryOutput['blend'],
    sx: number,
    sy: number,
    sz: number,
  ): THREE.Mesh<THREE.BufferGeometry, THREE.Material> {
    const { mesh } = poolEntry
    const geo = geometryData!
    this.updateGeometryAttribute(mesh.geometry, 'position', geo.positions, 3)
    this.updateGeometryAttribute(mesh.geometry, 'normal', geo.normals, 3)
    this.updateGeometryAttribute(mesh.geometry, 'color', geo.colors, 3)
    this.updateGeometryAttribute(mesh.geometry, 'uv', geo.uvs, 2)
    mesh.geometry.index = new THREE.BufferAttribute(geo.indices as Uint32Array | Uint16Array, 1)
    mesh.geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(-8, -8, -8),
      new THREE.Vector3(8, 8, 8),
    )
    mesh.geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(0, 0, 0),
      Math.sqrt(3 * 8 ** 2),
    )
    setupLegacySectionMatrix(mesh, sx, sy, sz)
    mesh.visible = false
    mesh.name = 'mesh'
    poolEntry.lastUsedTime = performance.now()
    return mesh as THREE.Mesh<THREE.BufferGeometry, THREE.Material>
  }

  private acquirePooledSectionMesh (sectionKey: string): ChunkMeshPool | null {
    let poolEntry = this.activeSections.get(sectionKey)
    if (!poolEntry) {
      poolEntry = this.acquireMesh()
      if (!poolEntry) {
        console.warn(`ChunkMeshManager: No available mesh in pool for section ${sectionKey}`)
        return null
      }
      this.activeSections.set(sectionKey, poolEntry)
      poolEntry.sectionKey = sectionKey
    }
    return poolEntry
  }

  updateSection (sectionKey: string, geometryData: MesherGeometryOutput): SectionObject | null {
    const hasOpaque = geometryData.positions.length > 0
    const hasBlend = (geometryData.blend?.positions.length ?? 0) > 0
    const hasLegacy = hasOpaque || hasBlend
    const shaderData = geometryData.shaderCubes
    const hasShader = this.isShaderCubesGpuEnabled() && (shaderData?.count ?? 0) > 0

    if (!hasLegacy && !hasShader) {
      this.releaseSection(sectionKey)
      return null
    }

    // Remove existing section object from scene if it exists
    let sectionObject = this.sectionObjects[sectionKey]
    if (sectionObject) {
      this.cleanupSection(sectionKey)
    }

    if (!hasBlend) {
      this.releasePooledMesh(sectionKey)
    }

    let legacyMesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material> | undefined
    let deferredLegacyOpaque: LegacySectionGeometry | undefined
    let deferredLegacyBlend: LegacySectionGeometry | undefined
    let hasBlendMesh = false

    if (hasOpaque) {
      const opaqueGeo: LegacySectionGeometry = {
        positions: geometryData.positions as Float32Array,
        colors: geometryData.colors as Float32Array,
        uvs: geometryData.uvs as Float32Array,
        indices: geometryData.indices as Uint32Array | Uint16Array,
      }
      const deferOpaque = this.shouldDeferLegacyOpaqueToPerSection(sectionKey)
      if (deferOpaque) {
        deferredLegacyOpaque = {
          positions: new Float32Array(opaqueGeo.positions),
          colors: new Float32Array(opaqueGeo.colors),
          uvs: new Float32Array(opaqueGeo.uvs),
          indices: opaqueGeo.indices instanceof Uint32Array
            ? new Uint32Array(opaqueGeo.indices)
            : new Uint16Array(opaqueGeo.indices),
        }
        if (!hasBlend) {
          const poolEntry = this.acquirePooledSectionMesh(sectionKey)
          if (!poolEntry) return null
          legacyMesh = this.uploadLegacyPooledMesh(poolEntry, geometryData, geometryData.sx, geometryData.sy, geometryData.sz)
        }
      } else {
        const added = this.getGlobalLegacyBuffer().addSection(
          sectionKey,
          opaqueGeo,
          geometryData.sx,
          geometryData.sy,
          geometryData.sz,
        )
        if (!added) {
          const poolEntry = this.acquirePooledSectionMesh(sectionKey)
          if (!poolEntry) return null
          legacyMesh = this.uploadLegacyPooledMesh(poolEntry, geometryData, geometryData.sx, geometryData.sy, geometryData.sz)
        }
      }
    }

    if (hasBlend && geometryData.blend) {
      const blendGeo: LegacySectionGeometry = {
        positions: geometryData.blend.positions as Float32Array,
        colors: geometryData.blend.colors as Float32Array,
        uvs: geometryData.blend.uvs as Float32Array,
        indices: geometryData.blend.indices as Uint32Array | Uint16Array,
      }
      const deferBlend = this.shouldDeferLegacyOpaqueToPerSection(sectionKey)
      if (deferBlend) {
        deferredLegacyBlend = {
          positions: new Float32Array(blendGeo.positions),
          colors: new Float32Array(blendGeo.colors),
          uvs: new Float32Array(blendGeo.uvs),
          indices: blendGeo.indices instanceof Uint32Array
            ? new Uint32Array(blendGeo.indices)
            : new Uint16Array(blendGeo.indices),
        }
        const poolEntry = this.acquirePooledSectionMesh(sectionKey)
        if (!poolEntry) return null
        const blendMesh = this.uploadLegacyPooledMesh(
          poolEntry,
          geometryData.blend,
          geometryData.sx,
          geometryData.sy,
          geometryData.sz,
        )
        legacyMesh = legacyMesh ?? blendMesh
        hasBlendMesh = true
      } else {
        const added = this.getGlobalLegacyBlendBuffer().addSection(
          sectionKey,
          blendGeo,
          geometryData.sx,
          geometryData.sy,
          geometryData.sz,
        )
        if (!added) {
          console.warn(`ChunkMeshManager: blend invariant violation for section ${sectionKey}, using pooled mesh fallback`)
          const poolEntry = this.acquirePooledSectionMesh(sectionKey)
          if (!poolEntry) return null
          const blendMesh = this.uploadLegacyPooledMesh(
            poolEntry,
            geometryData.blend,
            geometryData.sx,
            geometryData.sy,
            geometryData.sz,
          )
          legacyMesh = legacyMesh ?? blendMesh
          hasBlendMesh = true
        }
      }
    }

    const cubeMaterial = hasShader ? this.getCubeShaderMaterial() : null
    let shaderMesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial> | undefined
    const deferShader = hasShader && this.shouldDeferShaderToPerSection(sectionKey)
    if (hasShader && shaderData) {
      if (deferShader && cubeMaterial) {
        shaderMesh = createShaderCubeMesh(shaderData, cubeMaterial)
        shaderMesh.visible = true
      } else {
        this.getGlobalBlockBuffer()?.addSection(sectionKey, shaderData.words, shaderData.count)
      }
    }

    sectionObject = new THREE.Group() as SectionObject
    if (legacyMesh) {
      sectionObject.add(legacyMesh)
      sectionObject.mesh = legacyMesh
    }
    if (shaderMesh) {
      sectionObject.add(shaderMesh)
      sectionObject.shaderMesh = shaderMesh
      if (shaderData) {
        sectionObject.deferredShaderCubes = {
          words: shaderData.words,
          count: shaderData.count,
        }
      }
      if (!sectionObject.mesh) {
        sectionObject.mesh = shaderMesh as unknown as THREE.Mesh<THREE.BufferGeometry, THREE.Material>
      }
    }
    if (deferredLegacyOpaque) {
      sectionObject.deferredLegacyOpaque = deferredLegacyOpaque
    }
    if (deferredLegacyBlend) {
      sectionObject.deferredLegacyBlend = deferredLegacyBlend
    }
    if (hasShader && shaderData) {
      this.registerShaderSectionRaycastBox(
        sectionKey,
        shaderData.words,
        shaderData.count,
        geometryData.sx,
        geometryData.sy,
        geometryData.sz,
      )
    }

    let tilesCount = 0
    if (hasOpaque) {
      tilesCount += geometryData.positions.length / 3 / 4
    }
    if (hasBlend && geometryData.blend) {
      tilesCount += geometryData.blend.positions.length / 3 / 4
    }
    if (hasShader && shaderData) {
      tilesCount += shaderData.count
    }
    sectionObject.tilesCount = tilesCount
    sectionObject.hasBlendMesh = hasBlendMesh
    sectionObject.blocksCount = geometryData.blocksCount
    sectionObject.worldX = geometryData.sx
    sectionObject.worldY = geometryData.sy
    sectionObject.worldZ = geometryData.sz
    // Stamp the section key so modules (e.g. sciFiWorldReveal) can resolve
    // mesh -> section without falling back to sceneOrigin world-position math.
    ;(sectionObject as any).sectionKey = sectionKey
    // Tag the group so `WorldRendererThree.getThirdPersonCamera` raycast can
    // still find chunk meshes — the old `WorldBlockGeometry` set this name
    // unconditionally; the pooling port lost that and only the border-helper
    // path used to restore it.
    sectionObject.name = 'chunk'

    try {
      // Add signs container
      if (Object.keys(geometryData.signs).length > 0) {
        const signsContainer = new THREE.Group()
        signsContainer.name = 'signs'
        for (const [posKey, { isWall, isHanging, rotation }] of Object.entries(geometryData.signs)) {
          const signBlockEntity = this.worldRenderer.blockEntities[posKey]
          if (!signBlockEntity) continue
          const [x, y, z] = posKey.split(',')
          const sign = this.signHeadsRenderer.renderSign(new Vec3(+x, +y, +z), rotation, isWall, isHanging, nbt.simplify(signBlockEntity))
          if (!sign) continue
          signsContainer.add(sign)
        }
        sectionObject.add(signsContainer)
        sectionObject.signsContainer = signsContainer
      }

      // Add heads container
      if (Object.keys(geometryData.heads).length > 0) {
        const headsContainer = new THREE.Group()
        headsContainer.name = 'heads'
        for (const [posKey, { isWall, rotation }] of Object.entries(geometryData.heads)) {
          const headBlockEntity = this.worldRenderer.blockEntities[posKey]
          if (!headBlockEntity) continue
          const [x, y, z] = posKey.split(',')
          const head = this.signHeadsRenderer.renderHead(new Vec3(+x, +y, +z), rotation, isWall, nbt.simplify(headBlockEntity))
          if (!head) continue
          headsContainer.add(head)
        }
        sectionObject.add(headsContainer)
        sectionObject.headsContainer = headsContainer
      }

      // Add banners container
      if (Object.keys(geometryData.banners).length > 0) {
        const bannersContainer = new THREE.Group()
        bannersContainer.name = 'banners'
        sectionObject.bannersContainer = bannersContainer
        sectionObject.add(bannersContainer)
        for (const [posKey, { isWall, rotation, blockName }] of Object.entries(geometryData.banners)) {
          const bannerBlockEntity = this.worldRenderer.blockEntities[posKey]
          if (!bannerBlockEntity) continue
          const [x, y, z] = posKey.split(',')
          const bannerTexture = getBannerTexture(this.worldRenderer, blockName, nbt.simplify(bannerBlockEntity))
          if (!bannerTexture) continue
          const banner = createBannerMesh(new Vec3(+x, +y, +z), rotation, isWall, bannerTexture)
          const { x: bwx, y: bwy, z: bwz } = banner.position
          this.worldRenderer.sceneOrigin.track(banner)
          banner.position.set(bwx, bwy, bwz)
          bannersContainer.add(banner)
        }
      }
    } catch (err) {
      console.error('ChunkMeshManager: Error adding signs, heads, or banners to section', err)
    }

    // Store and add to scene
    this.sectionObjects[sectionKey] = sectionObject
    this.scene.add(sectionObject)
    sectionObject.matrixAutoUpdate = false

    // Create chunk border helper eagerly when the option is on so freshly
    // streamed sections immediately get the F3+G yellow wireframe instead of
    // appearing only on the next toggle.
    if (this.worldRenderer.displayOptions?.inWorldRenderingConfig?.showChunkBorders) {
      this.updateBoxHelper(sectionKey, true)
    }

    // Honor "Batch Chunks Display" (`_renderByChunks`): keep this section's
    // mesh hidden until the whole chunk has finished meshing, so users see a
    // chunk appear as a single 16xHx16 tile instead of streaming per-section.
    // Updates to chunks that are already finished bypass batching to avoid
    // flickering on block changes / lighting updates.
    // For the WASM column path we force batching ON regardless of the user
    // setting so the near-first reveal gate has sections to hold.
    const chunkCoords = sectionKey.split(',')
    const chunkKey = `${chunkCoords[0]},${chunkCoords[2]}`
    const renderByChunks = !!this.worldRenderer.displayOptions
      ?.inWorldRenderingConfig?._renderByChunks
    const forceBatchForWasm = !!this.worldRenderer.worldRendererConfig?.wasmMesher
    if ((renderByChunks || forceBatchForWasm) && !this.worldRenderer.finishedChunks[chunkKey]) {
      sectionObject.visible = false
      sectionObject._waitingForChunkDisplay = true
      const list = this.waitingChunksToDisplay[chunkKey] ?? (this.waitingChunksToDisplay[chunkKey] = [])
      if (!list.includes(sectionKey)) list.push(sectionKey)
    }

    return sectionObject
  }

  /**
   * Reveal all sections of a chunk that were held invisible by the
   * "Batch Chunks Display" option. Called from `WorldRendererThree.finishChunk`.
   *
   * For the WASM path: if any nearer column is not yet finished, the
   * reveal is deferred (parked in `pendingNearReveal`) and re-checked on
   * the next chunkFinished / player-move / grace-expiry.
   */
  finishChunkDisplay (chunkKey: string): void {
    const sectionKeys = this.waitingChunksToDisplay[chunkKey]
    if (!sectionKeys) {
      // No held sections (empty column / non-batched path) — but the
      // chunk just transitioned to finished, so re-check pending farther.
      this.tryRevealPending()
      return
    }
    if (this.isWasmGateActive() && this.isBlockedByNearer(chunkKey, 0)) {
      this.pendingNearReveal.set(chunkKey, Date.now())
      this.armNearRevealTimer(chunkKey)
      this.armExpectedGraceTimer(chunkKey)
      this.tryRevealPending()
      return
    }
    this.flushChunkDisplay(chunkKey)
    this.tryRevealPending()
  }

  private flushChunkDisplay (chunkKey: string): void {
    const sectionKeys = this.waitingChunksToDisplay[chunkKey]
    this.pendingNearReveal.delete(chunkKey)
    this.clearNearRevealTimer(chunkKey)
    this.clearExpectedGraceTimer(chunkKey)
    if (!sectionKeys) return
    for (const sectionKey of sectionKeys) {
      const sectionObject = this.sectionObjects[sectionKey]
      if (!sectionObject) continue
      sectionObject._waitingForChunkDisplay = false
      sectionObject.visible = true
    }
    delete this.waitingChunksToDisplay[chunkKey]
  }

  // Re-check every parked entry; each has its own grace window via `ageMs`.
  // Single pass is enough — pending entries are already finished, so flushing
  // one cannot un-block another via this code path (cascading happens via
  // chunkFinished events and per-pending grace timers).
  tryRevealPending (): void {
    if (this.pendingNearReveal.size === 0) return
    const now = Date.now()
    for (const [chunkKey, enqueuedAt] of [...this.pendingNearReveal]) {
      if (!this.isBlockedByNearer(chunkKey, now - enqueuedAt)) {
        this.flushChunkDisplay(chunkKey)
      }
    }
  }

  // Drop gate state for an unloaded column and re-evaluate any farther
  // chunks that may have been blocked by it.
  onChunkRemovedFromGate (chunkKey: string): void {
    this.pendingNearReveal.delete(chunkKey)
    this.clearNearRevealTimer(chunkKey)
    this.clearExpectedGraceTimer(chunkKey)
    delete this.waitingChunksToDisplay[chunkKey]
    this.tryRevealPending()
  }

  private isWasmGateActive (): boolean {
    return !!this.worldRenderer.worldRendererConfig?.wasmMesher
  }

  /**
   * True if some chunk-grid position strictly closer to the viewer than
   * `chunkKey` is not yet `finishedChunks=true`.
   *
   * Two regimes by `ageMs` (time spent in `pendingNearReveal`):
   * - Within `EXPECTED_NEAR_GRACE_MS`: nearer columns in the circle that are
   *   loaded but not finished block (far worker beats near worker).
   * - After grace: only actually-loaded-but-not-finished columns block,
   *   so a never-arriving column does not freeze the view.
   */
  private isBlockedByNearer (chunkKey: string, ageMs: number): boolean {
    const viewer = this.worldRenderer.viewerChunkPosition
    if (!viewer) return false
    const ownParts = chunkKey.split(',')
    if (ownParts.length !== 2) return false
    const ownX = Number(ownParts[0])
    const ownZ = Number(ownParts[1])
    const playerCx = Math.floor(viewer.x / 16)
    const playerCz = Math.floor(viewer.z / 16)
    const myDx = (ownX >> 4) - playerCx
    const myDz = (ownZ >> 4) - playerCz
    const myDist = myDx * myDx + myDz * myDz
    if (myDist === 0) return false
    const finishedChunks = this.worldRenderer.finishedChunks
    const loadedChunks = this.worldRenderer.loadedChunks
    const viewDist = this.worldRenderer.viewDistance
    const inGrace = ageMs < ChunkMeshManager.EXPECTED_NEAR_GRACE_MS && viewDist > 0

    if (inGrace) {
      const viewDistSq = viewDist * viewDist
      const limit = Math.min(viewDist, Math.ceil(Math.sqrt(Math.max(0, myDist - 1))))
      for (let dCx = -limit; dCx <= limit; dCx++) {
        for (let dCz = -limit; dCz <= limit; dCz++) {
          const oDistSq = dCx * dCx + dCz * dCz
          if (oDistSq >= myDist || oDistSq > viewDistSq) continue
          const ox = (playerCx + dCx) << 4
          const oz = (playerCz + dCz) << 4
          const otherKey = `${ox},${oz}`
          if (otherKey === chunkKey) continue
          if (!loadedChunks[otherKey]) continue
          if (!finishedChunks[otherKey]) return true
        }
      }
      return false
    }

    for (const otherKey in loadedChunks) {
      if (otherKey === chunkKey || finishedChunks[otherKey]) continue
      const parts = otherKey.split(',')
      if (parts.length !== 2) continue
      const odx = (Number(parts[0]) >> 4) - playerCx
      const odz = (Number(parts[1]) >> 4) - playerCz
      if (odx * odx + odz * odz < myDist) return true
    }
    return false
  }

  private armNearRevealTimer (chunkKey: string): void {
    if (this.nearRevealTimers.has(chunkKey)) return
    const timer = setTimeout(() => {
      this.nearRevealTimers.delete(chunkKey)
      if (!this.pendingNearReveal.has(chunkKey)) return
      console.warn(`[chunk-reveal] safety timeout for ${chunkKey} — a nearer pending column never finished, force-revealing`)
      this.flushChunkDisplay(chunkKey)
      this.tryRevealPending()
    }, ChunkMeshManager.NEAR_REVEAL_TIMEOUT_MS)
    this.nearRevealTimers.set(chunkKey, timer)
  }

  private clearNearRevealTimer (chunkKey: string): void {
    const timer = this.nearRevealTimers.get(chunkKey)
    if (timer) {
      clearTimeout(timer)
      this.nearRevealTimers.delete(chunkKey)
    }
  }

  /**
   * Schedule a re-evaluation just after the grace window expires so that
   * "expected but never arrived" positions stop blocking promptly,
   * without waiting for the next chunkFinished / player-move event.
   */
  private armExpectedGraceTimer (chunkKey: string): void {
    if (this.nearRevealGraceTimers.has(chunkKey)) return
    const timer = setTimeout(() => {
      this.nearRevealGraceTimers.delete(chunkKey)
      if (!this.pendingNearReveal.has(chunkKey)) return
      this.tryRevealPending()
    }, ChunkMeshManager.EXPECTED_NEAR_GRACE_MS + 50)
    this.nearRevealGraceTimers.set(chunkKey, timer)
  }

  private clearExpectedGraceTimer (chunkKey: string): void {
    const timer = this.nearRevealGraceTimers.get(chunkKey)
    if (timer) {
      clearTimeout(timer)
      this.nearRevealGraceTimers.delete(chunkKey)
    }
  }

  cleanupSection (sectionKey: string) {
    // Remove section object from scene
    const sectionObject = this.sectionObjects[sectionKey]
    if (sectionObject) {
      // Drop from any pending "batch display" queue so we don't try to flip
      // visibility on a stale (released) object later.
      if (sectionObject._waitingForChunkDisplay) {
        const chunkCoords = sectionKey.split(',')
        const chunkKey = `${chunkCoords[0]},${chunkCoords[2]}`
        const list = this.waitingChunksToDisplay[chunkKey]
        if (list) {
          const idx = list.indexOf(sectionKey)
          if (idx !== -1) list.splice(idx, 1)
          if (list.length === 0) delete this.waitingChunksToDisplay[chunkKey]
        }
      }
      // Cleanup banner textures before disposing
      if (sectionObject.bannersContainer) {
        sectionObject.bannersContainer.traverse((child) => {
          if ((child as any).bannerTexture) {
            releaseBannerTexture((child as any).bannerTexture)
          }
        })
        this.disposeContainer(sectionObject.bannersContainer)
      }
      this.globalBlockBuffer?.removeSection(sectionKey)
      this.globalLegacyBuffer?.removeSection(sectionKey)
      this.globalLegacyBlendBuffer?.removeSection(sectionKey)
      this.unregisterShaderSectionRaycastBox(sectionKey)
      delete sectionObject.deferredLegacyOpaque
      delete sectionObject.deferredLegacyBlend
      if (sectionObject.shaderMesh) {
        disposeShaderCubeMesh(sectionObject.shaderMesh)
        sectionObject.shaderMesh = undefined
      }
      delete sectionObject.deferredShaderCubes
      // Dispose signs and heads containers
      if (sectionObject.signsContainer) {
        this.disposeContainer(sectionObject.signsContainer)
      }
      if (sectionObject.headsContainer) {
        this.disposeContainer(sectionObject.headsContainer)
      }
      this.worldRenderer.sceneOrigin.removeAndUntrackAll(sectionObject)
      this.scene.remove(sectionObject)
      // boxHelper lives directly on the scene (so it stays world-anchored
      // under camera-relative rendering), so it must be cleaned up explicitly
      // — `removeAndUntrackAll` above only walks `sectionObject` descendants.
      if (sectionObject.boxHelper) {
        this.worldRenderer.sceneOrigin.removeAndUntrack(sectionObject.boxHelper)
        this.scene.remove(sectionObject.boxHelper)
        sectionObject.boxHelper.geometry.dispose()
        const helperMat = sectionObject.boxHelper.material as THREE.Material | THREE.Material[]
        if (Array.isArray(helperMat)) {
          for (const m of helperMat) m.dispose()
        } else {
          helperMat.dispose()
        }
        sectionObject.boxHelper = undefined
      }
      delete this.sectionObjects[sectionKey]
    }
  }

  /**
   * Release a section and return its mesh to the pool
   */
  private releasePooledMesh (sectionKey: string): void {
    const poolEntry = this.activeSections.get(sectionKey)
    if (!poolEntry) return

    poolEntry.mesh.visible = false
    poolEntry.inUse = false
    poolEntry.sectionKey = undefined
    poolEntry.lastUsedTime = 0
    this.clearGeometry(poolEntry.mesh.geometry)
    this.activeSections.delete(sectionKey)
    this.cleanupExcessMeshes()
  }

  releaseSection (sectionKey: string): boolean {
    this.cleanupSection(sectionKey)

    const poolEntry = this.activeSections.get(sectionKey)
    if (!poolEntry) {
      return false
    }

    // Hide mesh and mark as available
    poolEntry.mesh.visible = false
    poolEntry.inUse = false
    poolEntry.sectionKey = undefined
    poolEntry.lastUsedTime = 0

    // Clear geometry to free memory
    this.clearGeometry(poolEntry.mesh.geometry)

    this.activeSections.delete(sectionKey)

    // Memory cleanup: if pool exceeds max size and we have free meshes, remove one
    this.cleanupExcessMeshes()

    return true
  }

  /**
   * Get section object if it exists
   */
  getSectionObject (sectionKey: string): SectionObject | undefined {
    return this.sectionObjects[sectionKey]
  }

  /**
   * Update box helper for a section
   */
  updateBoxHelper (sectionKey: string, showChunkBorders: boolean, chunkBoxMaterial: THREE.Material = this.chunkBoxMaterial) {
    const sectionObject = this.sectionObjects[sectionKey]
    if (!sectionObject) return

    if (showChunkBorders) {
      if (!sectionObject.boxHelper) {
        // Build a 16x16x16 reference mesh in world coordinates so BoxHelper's
        // `setFromObject` produces the correct geometry. The reference mesh is
        // not added to the scene; only the resulting BoxHelper is.
        const staticChunkMesh = new THREE.Mesh(new THREE.BoxGeometry(16, 16, 16), chunkBoxMaterial)
        const boxHelper = new THREE.BoxHelper(staticChunkMesh, 0xff_ff_00)
        boxHelper.name = 'helper'
        // Add directly to the scene and track it through sceneOrigin so that
        // camera-relative rendering (floating origin) keeps the helper pinned
        // to its world coordinates instead of following the camera.
        const sx = sectionObject.worldX ?? 0
        const sy = sectionObject.worldY ?? 0
        const sz = sectionObject.worldZ ?? 0
        this.worldRenderer.sceneOrigin.track(boxHelper, { updateMatrix: true })
        boxHelper.position.set(sx, sy, sz)
        boxHelper.updateMatrix()
        this.scene.add(boxHelper)
        sectionObject.boxHelper = boxHelper
      }
      sectionObject.boxHelper.visible = true
    } else if (sectionObject.boxHelper) {
      sectionObject.boxHelper.visible = false
    }
  }

  /**
   * Create / toggle chunk border helpers for every active section. Used by
   * `WorldRendererThree.updateShowChunksBorder` so the F3+G hotkey works
   * after the move from `WorldBlockGeometry` (which created the helpers
   * eagerly per section) to the pooled `ChunkMeshManager`.
   */
  updateAllBoxHelpers (showChunkBorders: boolean) {
    for (const sectionKey of Object.keys(this.sectionObjects)) {
      this.updateBoxHelper(sectionKey, showChunkBorders)
    }
  }

  /**
   * Forward to {@link SignHeadsRenderer.cleanChunkTextures} so callers in
   * `WorldRendererThree` (which historically owned the sign-texture cache)
   * can invalidate cached sign textures when a section is marked dirty,
   * without reaching into the manager's private members.
   */
  cleanSignChunkTextures (x: number, z: number) {
    this.signHeadsRenderer.cleanChunkTextures(x, z)
  }

  /**
   * Get mesh for section if it exists
   */
  getSectionMesh (sectionKey: string): THREE.Mesh | undefined {
    return this.activeSections.get(sectionKey)?.mesh
  }

  /**
   * Check if section is managed by this pool
   */
  hasSection (sectionKey: string): boolean {
    return this.activeSections.has(sectionKey)
  }

  /**
   * Update pool size based on new view distance
   */
  updateViewDistance (maxViewDistance: number) {
    // Calculate dynamic pool size based on view distance
    const chunksInView = (maxViewDistance * 2 + 1) ** 2
    const maxSectionsPerChunk = this.worldHeight / 16
    const avgSectionsPerChunk = 5
    this.minPoolSize = Math.floor(chunksInView * avgSectionsPerChunk)
    this.maxPoolSize = Math.floor(chunksInView * maxSectionsPerChunk) + 1
    this.poolSize ??= this.minPoolSize

    // Expand pool if needed to reach optimal size
    if (this.minPoolSize > this.poolSize) {
      const targetSize = Math.min(this.minPoolSize, this.maxPoolSize)
      this.expandPool(targetSize)
    }

    console.log(`ChunkMeshManager: Updated view max distance to ${maxViewDistance}, pool: ${this.poolSize}/${this.maxPoolSize}, optimal: ${this.minPoolSize}`)
  }

  /**
   * Get pool statistics
   */
  getStats () {
    const freeCount = this.meshPool.filter(entry => !entry.inUse).length
    const hitRate = this.hits + this.misses > 0 ? (this.hits / (this.hits + this.misses) * 100).toFixed(1) : '0'
    const memoryUsage = this.getEstimatedMemoryUsage()

    return {
      poolSize: this.poolSize,
      activeCount: this.activeSections.size,
      freeCount,
      hitRate: `${hitRate}%`,
      hits: this.hits,
      misses: this.misses,
      memoryUsage
    }
  }

  /**
   * Get total tiles rendered
   */
  getTotalTiles (): number {
    return Object.values(this.sectionObjects).reduce((acc, obj) => acc + (obj.tilesCount || 0), 0)
  }

  /**
   * Get total blocks rendered
   */
  getTotalBlocks (): number {
    return Object.values(this.sectionObjects).reduce((acc, obj) => acc + (obj.blocksCount || 0), 0)
  }

  /**
   * Estimate memory usage in MB
   */
  getEstimatedMemoryUsage (): { total: string, breakdown: any } {
    let totalBytes = 0
    let positionBytes = 0
    let normalBytes = 0
    let colorBytes = 0
    let uvBytes = 0
    let indexBytes = 0
    let shaderInstanceBytes = 0

    const globalGeom = this.globalBlockBuffer?.mesh.geometry
    if (globalGeom) {
      for (const name of ['a_w0', 'a_w1', 'a_w2', 'a_w3'] as const) {
        const attr = globalGeom.getAttribute(name)
        if (attr) {
          const bytes = attr.array.byteLength
          shaderInstanceBytes += bytes
          totalBytes += bytes
        }
      }
    }

    const legacyGlobalBytes = this.globalLegacyBuffer?.getMemoryBytes() ?? 0
    const legacyBlendGlobalBytes = this.globalLegacyBlendBuffer?.getMemoryBytes() ?? 0
    totalBytes += legacyGlobalBytes + legacyBlendGlobalBytes
    positionBytes += legacyGlobalBytes + legacyBlendGlobalBytes

    for (const sectionObject of Object.values(this.sectionObjects)) {
      const geom = sectionObject.shaderMesh?.geometry
      if (!geom) continue
      for (const name of ['a_w0', 'a_w1', 'a_w2', 'a_w3'] as const) {
        const attr = geom.getAttribute(name)
        if (attr) {
          const bytes = attr.array.byteLength
          shaderInstanceBytes += bytes
          totalBytes += bytes
        }
      }
    }

    for (const poolEntry of this.meshPool) {
      if (poolEntry.inUse && poolEntry.mesh.geometry) {
        const { geometry } = poolEntry.mesh

        const position = geometry.getAttribute('position')
        if (position) {
          const bytes = position.array.byteLength
          positionBytes += bytes
          totalBytes += bytes
        }

        const normal = geometry.getAttribute('normal')
        if (normal) {
          const bytes = normal.array.byteLength
          normalBytes += bytes
          totalBytes += bytes
        }

        const color = geometry.getAttribute('color')
        if (color) {
          const bytes = color.array.byteLength
          colorBytes += bytes
          totalBytes += bytes
        }

        const uv = geometry.getAttribute('uv')
        if (uv) {
          const bytes = uv.array.byteLength
          uvBytes += bytes
          totalBytes += bytes
        }

        if (geometry.index) {
          const bytes = geometry.index.array.byteLength
          indexBytes += bytes
          totalBytes += bytes
        }
      }
    }

    const totalMB = (totalBytes / (1024 * 1024)).toFixed(2)

    return {
      total: `${totalMB} MB`,
      breakdown: {
        position: `${(positionBytes / (1024 * 1024)).toFixed(2)} MB`,
        normal: `${(normalBytes / (1024 * 1024)).toFixed(2)} MB`,
        color: `${(colorBytes / (1024 * 1024)).toFixed(2)} MB`,
        uv: `${(uvBytes / (1024 * 1024)).toFixed(2)} MB`,
        index: `${(indexBytes / (1024 * 1024)).toFixed(2)} MB`,
        shaderInstances: `${(shaderInstanceBytes / (1024 * 1024)).toFixed(2)} MB`,
      }
    }
  }

  /**
   * Cleanup and dispose resources
   */
  dispose () {
    // Release all active sections (snapshot keys to avoid mutating map during iteration)
    const activeKeys = [...this.activeSections.keys()]
    for (const sectionKey of activeKeys) {
      this.releaseSection(sectionKey)
    }

    this.signHeadsRenderer.dispose()

    // Dispose all meshes and geometries
    for (const poolEntry of this.meshPool) {
      // Meshes will be removed from scene when their parent containers are removed
      poolEntry.mesh.geometry.dispose()
    }

    this.meshPool.length = 0
    this.activeSections.clear()
    this.chunkBoxMaterial.dispose()
    this.shaderSectionRaycastBoxes.clear()
    this.globalBlockBuffer?.dispose()
    this.globalBlockBuffer = null
    this.globalLegacyBuffer?.dispose()
    this.globalLegacyBuffer = null
    this.globalLegacyBlendBuffer?.dispose()
    this.globalLegacyBlendBuffer = null
    this.cubeShaderMaterial?.dispose()
    this.cubeShaderMaterial = null
    this.legacyShaderMaterial?.dispose()
    this.legacyShaderMaterial = null
    this.globalLegacyShaderMaterial?.dispose()
    this.globalLegacyShaderMaterial = null
    this.globalLegacyBlendShaderMaterial?.dispose()
    this.globalLegacyBlendShaderMaterial = null
    // Drop any pending near-first reveal state and cancel safety timers.
    this.pendingNearReveal.clear()
    for (const timer of this.nearRevealTimers.values()) clearTimeout(timer)
    this.nearRevealTimers.clear()
    for (const timer of this.nearRevealGraceTimers.values()) clearTimeout(timer)
    this.nearRevealGraceTimers.clear()
  }

  // Private helper methods

  private acquireMesh (): ChunkMeshPool | undefined {
    if (this.bypassPooling) {
      const entry: ChunkMeshPool = {
        mesh: new THREE.Mesh(new THREE.BufferGeometry(), this.getLegacyShaderMaterial()),
        inUse: true,
        lastUsedTime: performance.now()
      }
      this.meshPool.push(entry)
      this.poolSize++
      return entry
    }

    // Find first available mesh
    for (const entry of this.meshPool) {
      if (!entry.inUse) {
        entry.inUse = true
        entry.lastUsedTime = performance.now()
        this.hits++
        return entry
      }
    }

    // No free mesh — expand pool
    this.misses++
    let newPoolSize = Math.min(this.poolSize + 16, this.maxPoolSize)
    if (newPoolSize <= this.meshPool.length) {
      // Already at or above max, do emergency expansion
      newPoolSize = this.meshPool.length + 8
      this.maxPoolSize = newPoolSize
      console.warn(`ChunkMeshManager: Pool exhausted (${this.poolSize}/${this.maxPoolSize}). Emergency expansion to ${newPoolSize}`)
    }
    this.expandPool(newPoolSize)

    // Try again — find the newly added free entry (no recursion)
    for (let i = this.meshPool.length - 1; i >= 0; i--) {
      const entry = this.meshPool[i]
      if (!entry.inUse) {
        entry.inUse = true
        entry.lastUsedTime = performance.now()
        return entry
      }
    }

    // Should never happen — expandPool guarantees new entries
    throw new Error('ChunkMeshManager: Failed to acquire mesh after pool expansion')
  }

  private expandPool (newSize: number) {
    const currentLength = this.meshPool.length
    this.poolSize = newSize

    // Add new meshes to pool
    for (let i = currentLength; i < newSize; i++) {
      const geometry = new THREE.BufferGeometry()
      const mesh = new THREE.Mesh(geometry, this.getLegacyShaderMaterial())
      mesh.visible = false
      mesh.matrixAutoUpdate = false
      mesh.name = 'pooled-section-mesh'

      const poolEntry: ChunkMeshPool = {
        mesh,
        inUse: false,
        lastUsedTime: 0
      }

      this.meshPool.push(poolEntry)
      // Don't add to scene here - meshes will be added to containers
    }
  }

  private updateGeometryAttribute (
    geometry: THREE.BufferGeometry,
    name: string,
    array: Float32Array,
    itemSize: number
  ) {
    const attribute = geometry.getAttribute(name)

    if (attribute && attribute.count === array.length / itemSize) {
      // Reuse existing attribute
      ;(attribute.array as Float32Array).set(array)
      attribute.needsUpdate = true
    } else {
      // Create new attribute (this will dispose the old one automatically)
      geometry.setAttribute(name, new THREE.BufferAttribute(array, itemSize))
    }
  }

  private clearGeometry (geometry: THREE.BufferGeometry) {
    const attributes = ['position', 'normal', 'color', 'uv']
    for (const name of attributes) {
      if (geometry.hasAttribute(name)) {
        geometry.deleteAttribute(name)
      }
    }
    if (geometry.index) {
      geometry.setIndex(null)
    }
    geometry.boundingBox = null
    geometry.boundingSphere = null
  }

  private cleanupExcessMeshes () {
    // If pool size exceeds max and we have free meshes, remove some
    if (this.poolSize > this.maxPoolSize) {
      const freeCount = this.meshPool.filter(entry => !entry.inUse).length
      if (freeCount > 0) {
        const excessCount = Math.min(this.poolSize - this.maxPoolSize, freeCount)
        for (let i = 0; i < excessCount; i++) {
          const freeIndex = this.meshPool.findIndex(entry => !entry.inUse)
          if (freeIndex !== -1) {
            const poolEntry = this.meshPool[freeIndex]
            poolEntry.mesh.geometry.dispose()
            this.meshPool.splice(freeIndex, 1)
            this.poolSize--
          }
        }
        // console.log(`ChunkMeshManager: Cleaned up ${excessCount} excess meshes. Pool size: ${this.poolSize}/${this.maxPoolSize}`)
      }
    }
  }

  private disposeContainer (container: THREE.Group) {
    disposeObject(container, true)
  }

  /**
   * Record render time for performance monitoring
   */
  recordRenderTime (renderTime: number): void {
    this.renderTimes.push(renderTime)
    if (this.renderTimes.length > this.maxRenderTimeSamples) {
      this.renderTimes.shift()
    }

    // Check performance periodically
    const now = performance.now()
    if (now - this.lastPerformanceCheck > this.performanceCheckInterval) {
      this.checkPerformance()
      this.lastPerformanceCheck = now
    }
  }

  /**
   * Get current effective render distance
   */
  getEffectiveRenderDistance (): number {
    return this.performanceOverrideDistance || this.worldRenderer.viewDistance
  }

  /**
   * Force reset performance override
   */
  resetPerformanceOverride (): void {
    this.performanceOverrideDistance = undefined
    this.renderTimes.length = 0
    console.log('ChunkMeshManager: Performance override reset')
  }

  /**
    * Get average render time
    */
  getAverageRenderTime (): number {
    if (this.renderTimes.length === 0) return 0
    return this.renderTimes.reduce((sum, time) => sum + time, 0) / this.renderTimes.length
  }

  /**
    * Check if performance is degraded and adjust render distance
    */
  private checkPerformance (): void {
    if (this.renderTimes.length < this.maxRenderTimeSamples) return

    const avgRenderTime = this.getAverageRenderTime()
    const targetRenderTime = 16.67 // 60 FPS target (16.67ms per frame)
    const performanceThreshold = targetRenderTime * 1.5 // 25ms threshold

    if (avgRenderTime > performanceThreshold) {
      // Performance is bad, reduce render distance
      const currentViewDistance = this.worldRenderer.viewDistance
      const newDistance = Math.max(1, Math.floor(currentViewDistance * 0.8))

      if (!this.performanceOverrideDistance || newDistance < this.performanceOverrideDistance) {
        this.performanceOverrideDistance = newDistance
        console.warn(`ChunkMeshManager: Performance degraded (${avgRenderTime.toFixed(2)}ms avg). Reducing effective render distance to ${newDistance}`)
      }
    } else if (this.performanceOverrideDistance && avgRenderTime < targetRenderTime * 1.1) {
      // Performance is good, gradually restore render distance
      const currentViewDistance = this.worldRenderer.viewDistance
      const newDistance = Math.min(currentViewDistance, this.performanceOverrideDistance + 1)

      if (newDistance !== this.performanceOverrideDistance) {
        this.performanceOverrideDistance = newDistance >= currentViewDistance ? undefined : newDistance
        console.log(`ChunkMeshManager: Performance improved. Restoring render distance to ${newDistance}`)
      }
    }
  }

  /**
   * Hide sections beyond performance override distance
   */
  updateSectionsVisibility (): void {
    const cameraPos = this.worldRenderer.cameraSectionPos
    for (const [sectionKey, sectionObject] of Object.entries(this.sectionObjects)) {
      // Don't override "Batch Chunks Display" hiding — those sections must
      // stay invisible until their chunk finishes meshing.
      if (sectionObject._waitingForChunkDisplay) {
        sectionObject.visible = false
        continue
      }
      if (!this.performanceOverrideDistance) {
        sectionObject.visible = true
        continue
      }

      const [x, y, z] = sectionKey.split(',').map(Number)
      const sectionPos = { x: x / 16, y: y / 16, z: z / 16 }

      // Calculate distance using hypot (same as render distance calculation)
      const dx = sectionPos.x - cameraPos.x
      const dz = sectionPos.z - cameraPos.z
      const distance = Math.floor(Math.hypot(dx, dz))

      sectionObject.visible = distance <= this.performanceOverrideDistance
    }
  }
}


class SignHeadsRenderer {
  chunkTextures = new Map<string, { [pos: string]: THREE.Texture }>()

  constructor (public worldRendererThree: WorldRendererThree) {
  }

  dispose () {
    for (const [, textures] of this.chunkTextures) {
      for (const key of Object.keys(textures)) {
        textures[key].dispose()
      }
    }
    this.chunkTextures.clear()
  }

  renderHead (position: Vec3, rotation: number, isWall: boolean, blockEntity) {
    let textureData: string
    if (blockEntity.SkullOwner) {
      textureData = blockEntity.SkullOwner.Properties?.textures?.[0]?.Value
    } else {
      textureData = blockEntity.profile?.properties?.find(p => p.name === 'textures')?.value
    }
    if (!textureData) return

    try {
      const decodedData = JSON.parse(Buffer.from(textureData, 'base64').toString())
      let skinUrl = decodedData.textures?.SKIN?.url
      const { skinTexturesProxy } = this.worldRendererThree.worldRendererConfig
      if (skinTexturesProxy) {
        skinUrl = skinUrl?.replace('http://textures.minecraft.net/', skinTexturesProxy)
          .replace('https://textures.minecraft.net/', skinTexturesProxy)
      }

      const mesh = getMesh(this.worldRendererThree, skinUrl, armorModel.head as any)
      const group = new THREE.Group()
      if (isWall) {
        mesh.position.set(0, 0.3125, 0.3125)
      }
      // move head model down as armor have a different offset than blocks
      mesh.position.y -= 23 / 16
      group.add(mesh)
      this.worldRendererThree.sceneOrigin.track(group)
      group.position.set(position.x + 0.5, position.y + 0.045, position.z + 0.5)
      group.rotation.set(
        0,
        -THREE.MathUtils.degToRad(rotation * (isWall ? 90 : 45 / 2)),
        0
      )
      group.scale.set(0.8, 0.8, 0.8)
      return group
    } catch (err) {
      console.error('Error decoding player texture:', err)
    }
  }

  renderSign (position: Vec3, rotation: number, isWall: boolean, isHanging: boolean, blockEntity) {
    const tex = this.getSignTexture(position, blockEntity, isHanging)

    if (!tex) return

    // todo implement
    // const key = JSON.stringify({ position, rotation, isWall })
    // if (this.signsCache.has(key)) {
    //   console.log('cached', key)
    // } else {
    //   this.signsCache.set(key, tex)
    // }

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true }))
    mesh.renderOrder = 999

    const lineHeight = 7 / 16
    const scaleFactor = isHanging ? 1.3 : 1
    mesh.scale.set(1 * scaleFactor, lineHeight * scaleFactor, 1 * scaleFactor)

    const thickness = (isHanging ? 2 : 1.5) / 16
    const wallSpacing = 0.25 / 16
    if (isWall && !isHanging) {
      mesh.position.set(0, 0, -0.5 + thickness + wallSpacing + 0.0001)
    } else {
      mesh.position.set(0, 0, thickness / 2 + 0.0001)
    }

    const group = new THREE.Group()
    group.rotation.set(
      0,
      -THREE.MathUtils.degToRad(rotation * (isWall ? 90 : 45 / 2)),
      0
    )
    group.add(mesh)
    const height = (isHanging ? 10 : 8) / 16
    const heightOffset = (isHanging ? 0 : isWall ? 4.333 : 9.333) / 16
    const textPosition = height / 2 + heightOffset
    this.worldRendererThree.sceneOrigin.track(group)
    group.position.set(position.x + 0.5, position.y + textPosition, position.z + 0.5)
    return group
  }

  getSignTexture (position: Vec3, blockEntity, isHanging, backSide = false) {
    const chunk = chunkPos(position)
    let textures = this.chunkTextures.get(`${chunk[0]},${chunk[1]}`)
    if (!textures) {
      textures = {}
      this.chunkTextures.set(`${chunk[0]},${chunk[1]}`, textures)
    }
    const texturekey = `${position.x},${position.y},${position.z}`
    // todo investigate bug and remove this so don't need to clean in section dirty
    if (textures[texturekey]) return textures[texturekey]

    const PrismarineChat = PrismarineChatLoader(this.worldRendererThree.version)
    const canvas = renderSign(blockEntity, isHanging, PrismarineChat)
    if (!canvas) return
    const tex = new THREE.Texture(canvas)
    tex.magFilter = THREE.NearestFilter
    tex.minFilter = THREE.NearestFilter
    tex.needsUpdate = true
    textures[texturekey] = tex
    return tex
  }

  /**
   * Dispose all cached sign textures for the chunk containing world coords
   * (x, z). Called from `WorldRendererThree.cleanChunkTextures` so that
   * re-meshes triggered by `setSectionDirty` (e.g. a player edits a sign)
   * pick up fresh block-entity NBT instead of returning the stale cached
   * texture from {@link SignHeadsRenderer.getSignTexture}.
   */
  cleanChunkTextures (x: number, z: number) {
    const key = `${Math.floor(x / 16)},${Math.floor(z / 16)}`
    const textures = this.chunkTextures.get(key)
    if (!textures) return
    for (const k of Object.keys(textures)) {
      textures[k].dispose()
      delete textures[k]
    }
  }
}
