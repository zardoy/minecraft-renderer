import * as THREE from 'three'
import { BasePlaygroundScene } from '../baseScene'
import { downloadWorldGeometry, loadWorldGeometryFromUrl, type ExportedWorldGeometry } from '../../three/worldGeometryExport'

type GeometryExportBackendMethods = {
  loadGeometryExport?: (exportData: ExportedWorldGeometry) => Promise<number>
}

/**
 * Scene for exporting/importing world geometry
 *
 * Usage:
 * - Load normally: builds world from blocks, can export geometry
 * - Load with ?geometryUrl=URL: loads pre-exported geometry from file (or default world-geometry.json)
 */
export default class extends BasePlaygroundScene {
  params = {
    exportGeometry: () => this.exportGeometry(),
    exportWithTexture: () => this.exportGeometry(true),
    showDebugMesh: true
  }

  // Loaded geometry data (when loading from URL)
  private loadedGeometry: ExportedWorldGeometry | null = null
  private readonly geometryUrl: string | null
  private debugHelpers: THREE.BoxHelper[] = []

  constructor() {
    const qs = new URLSearchParams(window.location.search)
    const geometryUrl = qs.get('geometryUrl') ?? 'world-geometry.json'

    // If loading from URL, skip normal world setup (viewDistance 0 means no chunks loaded)
    super({
      viewDistance: geometryUrl ? 0 : 1,
      continuousRender: false,
      enableCameraOrbitControl: false
    })

    this.geometryUrl = geometryUrl
  }

  // Override initData to load geometry after base initialization completes
  override async initData() {
    await super.initData()

    // Now camera and worldRenderer are ready - load geometry if URL provided
    if (this.geometryUrl) {
      await this.loadFromUrl(this.geometryUrl)
    }

    // Setup param update handler for debug mesh toggle
    this.onParamUpdate.showDebugMesh = () => {
      this.updateDebugMeshVisibility()
      this.requestRender()
    }
  }

  setupWorld() {
    if (this.geometryUrl) {
      return
    }
    // Default world setup - add some blocks for testing
    this.addWorldBlock(0, 0, 0, 'stone')
    this.addWorldBlock(1, 0, 0, 'grass_block')
    this.addWorldBlock(0, 0, 1, 'dirt')
    this.addWorldBlock(1, 0, 1, 'cobblestone')
    this.addWorldBlock(0, 1, 0, 'oak_log')
    this.addWorldBlock(1, 1, 0, 'oak_planks')
  }

  private async loadFromUrl(url: string) {
    try {
      console.log('Loading geometry from:', url)
      this.loadedGeometry = await loadWorldGeometryFromUrl(url)

      // Restore camera position and rotation
      const { camera: camData } = this.loadedGeometry
      this.camera.position.set(camData.position.x, camData.position.y, camData.position.z)

      // Apply rotation using lookAt direction
      const { pitch, yaw } = camData.rotation
      const forward = new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
      this.camera.lookAt(camData.position.x + forward.x, camData.position.y + forward.y, camData.position.z + forward.z)
      this.controls?.update()
      this.syncCameraToBackend()

      const backendMethods = this.appViewer.backend?.backendMethods as GeometryExportBackendMethods | undefined
      if (!backendMethods?.loadGeometryExport) {
        console.warn('Three.js backend does not expose loadGeometryExport')
        return
      }

      const geometryData = this.loadedGeometry
      if (!geometryData) {
        console.warn('No geometry data available after load')
        return
      }

      const importedCount = await backendMethods.loadGeometryExport(geometryData)
      console.log(`Loaded ${importedCount} sections from geometry file`)

      // Add debug mesh helpers for all imported geometry
      this.addDebugMeshes()
      this.updateDebugMeshVisibility()

      this.requestRender()
    } catch (err) {
      console.error('Failed to load geometry:', err)
    }
  }

  private addDebugMeshes() {
    const { worldRenderer } = this
    if (!worldRenderer) return

    // Clear existing helpers
    this.removeDebugMeshes()

    // Find the geometry export container
    const container = worldRenderer.scene.getObjectByName('geometry-export-root')
    if (!container) return

    // Traverse all meshes and add BoxHelper for each
    container.traverse(obj => {
      if ((obj as THREE.Mesh).isMesh && obj.name === 'mesh') {
        const mesh = obj as THREE.Mesh
        const helper = new THREE.BoxHelper(mesh, 0xff_ff_00)
        helper.name = 'debug-helper'
        mesh.add(helper)
        this.debugHelpers.push(helper)
      }
    })
  }

  private removeDebugMeshes() {
    for (const helper of this.debugHelpers) {
      helper.parent?.remove(helper)
      helper.dispose()
    }
    this.debugHelpers = []
  }

  private updateDebugMeshVisibility() {
    const visible = this.params.showDebugMesh ?? true
    for (const helper of this.debugHelpers) {
      helper.visible = visible
    }
  }

  private exportGeometry(includeTexture = false) {
    const { worldRenderer } = this
    if (!worldRenderer) {
      console.error('WorldRenderer not available')
      return
    }

    // Get camera position and rotation
    const cameraPosition = {
      x: this.camera.position.x,
      y: this.camera.position.y,
      z: this.camera.position.z
    }

    // Extract yaw/pitch from camera quaternion
    const forward = new THREE.Vector3(0, 0, -1)
    forward.applyQuaternion(this.camera.quaternion)
    const cameraRotation = {
      yaw: Math.atan2(-forward.x, -forward.z),
      pitch: Math.asin(forward.y)
    }

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
    const filename = `world-geometry-${timestamp}.json`

    downloadWorldGeometry(worldRenderer, cameraPosition, cameraRotation, filename, includeTexture)
    console.log('Geometry exported to:', filename)
  }
}
