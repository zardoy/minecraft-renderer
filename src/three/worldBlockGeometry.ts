import * as THREE from 'three'
import { Vec3 } from 'vec3'
import nbt from 'prismarine-nbt'
import { MesherGeometryOutput, IS_FULL_WORLD_SECTION } from '../mesher/shared'
import { getBannerTexture, createBannerMesh, releaseBannerTexture } from './bannerRenderer'
import { disposeObject } from './threeJsUtils'
import type { WorldRendererThree } from './worldRendererThree'

export interface SectionObject extends THREE.Object3D {
  foutain?: boolean
  tilesCount?: number
  blocksCount?: number
}

export class WorldBlockGeometry {
  sectionObjects: Record<string, SectionObject> = {}
  waitingChunksToDisplay: { [chunkKey: string]: string[] } = {}
  estimatedMemoryUsage = 0

  constructor(
    private readonly worldRenderer: WorldRendererThree,
    private readonly scene: THREE.Scene,
    private readonly material: THREE.MeshLambertMaterial,
    private readonly displayOptions: any
  ) { }

  handleWorkerGeometryMessage(data: { geometry: MesherGeometryOutput; key: string; type: string }): void {
    let object: THREE.Object3D = this.sectionObjects[data.key]
    if (object) {
      // Track memory usage removal for existing section
      this.removeSectionMemoryUsage(object)
      // Cleanup banner textures before disposing
      object.traverse((child) => {
        if ((child as any).bannerTexture) {
          releaseBannerTexture((child as any).bannerTexture)
        }
      })
      this.worldRenderer.sceneOrigin.removeAndUntrackAll(object)
      disposeObject(object)
      delete this.sectionObjects[data.key]
    }

    const chunkCoords = data.key.split(',')
    if (
      !this.worldRenderer.loadedChunks[chunkCoords[0] + ',' + chunkCoords[2]] ||
      !data.geometry.positions.length ||
      !this.worldRenderer.active
    )
      return

    const geometry = new THREE.BufferGeometry()
    const positionAttr = new THREE.BufferAttribute(data.geometry.positions, 3)
    const normalAttr = new THREE.BufferAttribute(data.geometry.normals, 3)
    const colorAttr = new THREE.BufferAttribute(data.geometry.colors, 3)
    const uvAttr = new THREE.BufferAttribute(data.geometry.uvs, 2)
    const indexAttr = new THREE.BufferAttribute(data.geometry.indices as Uint32Array | Uint16Array, 1)

    geometry.setAttribute('position', positionAttr)
    geometry.setAttribute('normal', normalAttr)
    geometry.setAttribute('color', colorAttr)
    geometry.setAttribute('uv', uvAttr)
    geometry.index = indexAttr

    // Track memory usage for this section
    this.addSectionMemoryUsage(geometry)

    const mesh = new THREE.Mesh(geometry, this.material)
    this.worldRenderer.sceneOrigin.track(mesh, { updateMatrix: true })
    mesh.position.set(data.geometry.sx, data.geometry.sy, data.geometry.sz)
    mesh.name = 'mesh'
    object = new THREE.Group()
    object.add(mesh)
    // mesh with static dimensions: 16x16xsectionHeight
    const sectionHeight = data.geometry.sectionEndY - data.geometry.sectionStartY
    const CHUNK_SIZE = 16
    const staticChunkMesh = new THREE.Mesh(
      new THREE.BoxGeometry(CHUNK_SIZE, sectionHeight, CHUNK_SIZE),
      new THREE.MeshBasicMaterial({ color: 0x00_00_00, transparent: true, opacity: 0 })
    )
    const boxHelper = new THREE.BoxHelper(staticChunkMesh, 0xff_ff_00)
    boxHelper.name = 'helper'
    this.worldRenderer.sceneOrigin.track(boxHelper, { updateMatrix: true })
    boxHelper.position.set(data.geometry.sx, data.geometry.sy, data.geometry.sz)
    object.add(boxHelper)
    object.name = 'chunk'
      ; (object as any).tilesCount = data.geometry.positions.length / 3 / 4
      ; (object as any).blocksCount = data.geometry.blocksCount
    if (!this.displayOptions.inWorldRenderingConfig.showChunkBorders) {
      boxHelper.visible = false
    }
    // should not compute it once
    if (Object.keys(data.geometry.signs).length) {
      for (const [posKey, { isWall, isHanging, rotation }] of Object.entries(data.geometry.signs)) {
        const signBlockEntity = this.worldRenderer.blockEntities[posKey]
        if (!signBlockEntity) continue
        const [x, y, z] = posKey.split(',')
        const sign = this.worldRenderer.renderSign(
          new Vec3(+x, +y, +z),
          rotation,
          isWall,
          isHanging,
          nbt.simplify(signBlockEntity)
        )
        if (!sign) continue
        object.add(sign)
      }
    }
    if (Object.keys(data.geometry.heads).length) {
      for (const [posKey, { isWall, rotation }] of Object.entries(data.geometry.heads)) {
        const headBlockEntity = this.worldRenderer.blockEntities[posKey]
        if (!headBlockEntity) continue
        const [x, y, z] = posKey.split(',')
        const head = this.worldRenderer.renderHead(
          new Vec3(+x, +y, +z),
          rotation,
          isWall,
          nbt.simplify(headBlockEntity)
        )
        if (!head) continue
        object.add(head)
      }
    }
    if (Object.keys(data.geometry.banners).length) {
      for (const [posKey, { isWall, rotation, blockName }] of Object.entries(data.geometry.banners)) {
        const bannerBlockEntity = this.worldRenderer.blockEntities[posKey]
        if (!bannerBlockEntity) continue
        const [x, y, z] = posKey.split(',')
        const bannerTexture = getBannerTexture(this.worldRenderer, blockName, nbt.simplify(bannerBlockEntity))
        if (!bannerTexture) continue
        const banner = createBannerMesh(new Vec3(+x, +y, +z), rotation, isWall, bannerTexture)
        const { x: bwx, y: bwy, z: bwz } = banner.position
        this.worldRenderer.sceneOrigin.track(banner)
        banner.position.set(bwx, bwy, bwz)
        object.add(banner)
      }
    }
    this.sectionObjects[data.key] = object
    if (this.displayOptions.inWorldRenderingConfig._renderByChunks) {
      object.visible = false
      const chunkKey = `${chunkCoords[0]},${chunkCoords[2]}`
      this.waitingChunksToDisplay[chunkKey] ??= []
      this.waitingChunksToDisplay[chunkKey].push(data.key)
      if (this.worldRenderer.finishedChunks[chunkKey]) {
        // todo it might happen even when it was not an update
        this.finishChunk(chunkKey)
      }
    }

    this.worldRenderer.updatePosDataChunk(data.key)
    object.matrixAutoUpdate = false
    // Force matrix update after setting camera-relative position (matrixAutoUpdate is false)
    object.updateMatrix()
    mesh.onAfterRender = (renderer, scene, camera, geometry, material, group) => {
      // mesh.matrixAutoUpdate = false
    }

    this.scene.add(object)
  }

  finishChunk(chunkKey: string) {
    for (const sectionKey of this.waitingChunksToDisplay[chunkKey] ?? []) {
      this.sectionObjects[sectionKey].visible = true
    }
    delete this.waitingChunksToDisplay[chunkKey]
  }


  /**
   * Estimate memory usage of BufferGeometry attributes
   */
  private estimateGeometryMemoryUsage(geometry: THREE.BufferGeometry): number {
    let memoryBytes = 0

    // Calculate memory for each attribute
    const { attributes } = geometry
    for (const [name, attribute] of Object.entries(attributes)) {
      if (attribute?.array) {
        // Each number in typed arrays takes different bytes:
        // Float32Array: 4 bytes per number
        // Uint32Array: 4 bytes per number
        // Uint16Array: 2 bytes per number
        const bytesPerElement = attribute.array.BYTES_PER_ELEMENT
        memoryBytes += attribute.array.length * bytesPerElement
      }
    }

    // Calculate memory for indices
    if (geometry.index?.array) {
      const bytesPerElement = geometry.index.array.BYTES_PER_ELEMENT
      memoryBytes += geometry.index.array.length * bytesPerElement
    }

    return memoryBytes
  }

  /**
   * Update memory usage when section is added
   */
  private addSectionMemoryUsage(geometry: THREE.BufferGeometry): void {
    const memoryUsage = this.estimateGeometryMemoryUsage(geometry)
    this.estimatedMemoryUsage += memoryUsage
  }

  /**
   * Update memory usage when section is removed
   */
  private removeSectionMemoryUsage(object: THREE.Object3D): void {
    // Find mesh with geometry in the object
    const mesh = object.children.find((child) => child.name === 'mesh') as THREE.Mesh
    if (mesh?.geometry) {
      const memoryUsage = this.estimateGeometryMemoryUsage(mesh.geometry)
      this.estimatedMemoryUsage -= memoryUsage
      this.estimatedMemoryUsage = Math.max(0, this.estimatedMemoryUsage) // Ensure non-negative
    }
  }

  /**
   * Get estimated memory usage in a human-readable format
   */
  getEstimatedMemoryUsage(): { bytes: number; readable: string } {
    const bytes = this.estimatedMemoryUsage
    const mb = bytes / (1024 * 1024)
    const readable = `${mb.toFixed(2)} MB`
    return { bytes, readable }
  }

  resetWorld() {
    for (const mesh of Object.values(this.sectionObjects)) {
      // Track memory usage removal for all sections
      this.removeSectionMemoryUsage(mesh)
      this.worldRenderer.sceneOrigin.removeAndUntrackAll(mesh)
    }
    this.sectionObjects = {}
    this.waitingChunksToDisplay = {}

    // Reset memory tracking since all sections are cleared
    this.estimatedMemoryUsage = 0
  }

  removeColumn(x: number, z: number) {
    const sectionHeight = this.worldRenderer.getSectionHeight()
    const worldMinY = this.worldRenderer.worldMinYRender
    if (IS_FULL_WORLD_SECTION) {
      // Only one section per chunk when full world section
      const y = worldMinY
      this.worldRenderer.setSectionDirty(new Vec3(x, y, z), false)
      const key = `${x},${y},${z}`
      const mesh = this.sectionObjects[key]
      if (mesh) {
        // Track memory usage removal
        this.removeSectionMemoryUsage(mesh)
        // Cleanup banner textures before disposing
        mesh.traverse((child) => {
          if ((child as any).bannerTexture) {
            releaseBannerTexture((child as any).bannerTexture)
          }
        })
        this.worldRenderer.sceneOrigin.removeAndUntrackAll(mesh)
        disposeObject(mesh)
      }
      delete this.sectionObjects[key]
    } else {
      for (let y = worldMinY; y < this.worldRenderer.worldSizeParams.worldHeight; y += sectionHeight) {
        this.worldRenderer.setSectionDirty(new Vec3(x, y, z), false)
        const key = `${x},${y},${z}`
        const mesh = this.sectionObjects[key]
        if (mesh) {
          // Track memory usage removal
          this.removeSectionMemoryUsage(mesh)
          // Cleanup banner textures before disposing
          mesh.traverse((child) => {
            if ((child as any).bannerTexture) {
              releaseBannerTexture((child as any).bannerTexture)
            }
          })
          this.worldRenderer.sceneOrigin.removeAndUntrackAll(mesh)
          disposeObject(mesh)
        }
        delete this.sectionObjects[key]
      }
    }
  }
}
