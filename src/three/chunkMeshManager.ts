import PrismarineChatLoader from 'prismarine-chat'
import * as THREE from 'three'
import * as nbt from 'prismarine-nbt'
import { Vec3 } from 'vec3'
import { MesherGeometryOutput } from '../mesher/shared'
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
  mesh?: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>
  tilesCount?: number
  blocksCount?: number

  signsContainer?: THREE.Group
  headsContainer?: THREE.Group
  bannersContainer?: THREE.Group
  boxHelper?: THREE.BoxHelper
  foutain?: boolean
}

export class ChunkMeshManager {
  private readonly meshPool: ChunkMeshPool[] = []
  private readonly activeSections = new Map<string, ChunkMeshPool>()
  readonly sectionObjects: Record<string, SectionObject> = {}
  private poolSize!: number
  private maxPoolSize!: number
  private minPoolSize!: number
  private readonly signHeadsRenderer: SignHeadsRenderer

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
    public scene: THREE.Group,
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
      const mesh = new THREE.Mesh(geometry, this.material)
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

  /**
   * Update or create a section with new geometry data
   */
  updateSection (sectionKey: string, geometryData: MesherGeometryOutput): SectionObject | null {
    // Remove existing section object from scene if it exists
    let sectionObject = this.sectionObjects[sectionKey]
    if (sectionObject) {
      this.cleanupSection(sectionKey)
    }

    // Get or create mesh from pool
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

    const { mesh } = poolEntry

    // Update geometry attributes efficiently
    this.updateGeometryAttribute(mesh.geometry, 'position', geometryData.positions, 3)
    this.updateGeometryAttribute(mesh.geometry, 'normal', geometryData.normals, 3)
    this.updateGeometryAttribute(mesh.geometry, 'color', geometryData.colors, 3)
    this.updateGeometryAttribute(mesh.geometry, 'uv', geometryData.uvs, 2)

    // Use direct index assignment for better performance (like before)
    mesh.geometry.index = new THREE.BufferAttribute(geometryData.indices as Uint32Array | Uint16Array, 1)

    // Set bounding box and sphere for the 16x16x16 section
    mesh.geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(-8, -8, -8),
      new THREE.Vector3(8, 8, 8)
    )
    mesh.geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(0, 0, 0),
      Math.sqrt(3 * 8 ** 2)
    )

    // Position the mesh
    this.worldRenderer.sceneOrigin.track(mesh, { updateMatrix: true })
    mesh.position.set(geometryData.sx, geometryData.sy, geometryData.sz)
    mesh.updateMatrix()
    mesh.visible = true
    mesh.name = 'mesh'

    poolEntry.lastUsedTime = performance.now()

    // Create or update the section object container
    sectionObject = new THREE.Group() as SectionObject
    sectionObject.add(mesh)
    sectionObject.mesh = mesh as THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>

    // Store metadata
    sectionObject.tilesCount = geometryData.positions.length / 3 / 4
    sectionObject.blocksCount = geometryData.blocksCount

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

    return sectionObject
  }

  cleanupSection (sectionKey: string) {
    // Remove section object from scene
    const sectionObject = this.sectionObjects[sectionKey]
    if (sectionObject) {
      // Cleanup banner textures before disposing
      if (sectionObject.bannersContainer) {
        sectionObject.bannersContainer.traverse((child) => {
          if ((child as any).bannerTexture) {
            releaseBannerTexture((child as any).bannerTexture)
          }
        })
        this.disposeContainer(sectionObject.bannersContainer)
      }
      // Dispose signs and heads containers
      if (sectionObject.signsContainer) {
        this.disposeContainer(sectionObject.signsContainer)
      }
      if (sectionObject.headsContainer) {
        this.disposeContainer(sectionObject.headsContainer)
      }
      this.worldRenderer.sceneOrigin.removeAndUntrackAll(sectionObject)
      this.scene.remove(sectionObject)
      delete this.sectionObjects[sectionKey]
    }
  }

  /**
   * Release a section and return its mesh to the pool
   */
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
  updateBoxHelper (sectionKey: string, showChunkBorders: boolean, chunkBoxMaterial: THREE.Material) {
    const sectionObject = this.sectionObjects[sectionKey]
    if (!sectionObject?.mesh) return

    if (showChunkBorders) {
      if (!sectionObject.boxHelper) {
        // mesh with static dimensions: 16x16x16
        const staticChunkMesh = new THREE.Mesh(new THREE.BoxGeometry(16, 16, 16), chunkBoxMaterial)
        staticChunkMesh.position.copy(sectionObject.mesh.position)
        const boxHelper = new THREE.BoxHelper(staticChunkMesh, 0xff_ff_00)
        boxHelper.name = 'helper'
        sectionObject.add(boxHelper)
        sectionObject.name = 'chunk'
        sectionObject.boxHelper = boxHelper
      }
      sectionObject.boxHelper.visible = true
    } else if (sectionObject.boxHelper) {
      sectionObject.boxHelper.visible = false
    }
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
  }

  // Private helper methods

  private acquireMesh (): ChunkMeshPool | undefined {
    if (this.bypassPooling) {
      const entry: ChunkMeshPool = {
        mesh: new THREE.Mesh(new THREE.BufferGeometry(), this.material),
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
      const mesh = new THREE.Mesh(geometry, this.material)
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
}
