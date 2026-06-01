import * as THREE from 'three'
import type { WorldRendererThree } from './worldRendererThree'
import type { ExportedSection, ExportedWorldGeometry } from '../mesher-shared/exportedGeometryTypes'
import { getShaderCubeResources } from '../wasm-mesher/bridge/shaderCubeBridge'
import { createCubeBlockMaterial } from './shaders/cubeBlockShader'
import { createShaderCubeMesh } from './shaderCubeMesh'

export type { ExportedSection, ExportedWorldGeometry } from '../mesher-shared/exportedGeometryTypes'

const GEOMETRY_EXPORT_GROUP_NAME = 'geometry-export-root'

/**
 * Export world geometry to a downloadable file
 */
export function exportWorldGeometry(
  worldRenderer: WorldRendererThree,
  cameraPosition: { x: number, y: number, z: number },
  cameraRotation: { pitch: number, yaw: number },
  includeTexture = false
): ExportedWorldGeometry {
  const sections: ExportedSection[] = []

  for (const [key, sectionObject] of Object.entries(worldRenderer.sectionObjects)) {
    const mesh = sectionObject.children.find(child => child.name === 'mesh') as THREE.Mesh | undefined
    if (!mesh?.geometry) continue

    const { geometry } = mesh
    const positionAttr = geometry.getAttribute('position') as THREE.BufferAttribute
    const normalAttr = geometry.getAttribute('normal') as THREE.BufferAttribute
    const colorAttr = geometry.getAttribute('color') as THREE.BufferAttribute
    const uvAttr = geometry.getAttribute('uv') as THREE.BufferAttribute
    const indexAttr = geometry.index!

    if (!positionAttr || !indexAttr) continue

    const wp = worldRenderer.sceneOrigin.getWorldPosition(mesh)
    sections.push({
      key,
      position: {
        x: wp?.x ?? worldRenderer.sceneOrigin.toWorldX(mesh.position.x),
        y: wp?.y ?? worldRenderer.sceneOrigin.toWorldY(mesh.position.y),
        z: wp?.z ?? worldRenderer.sceneOrigin.toWorldZ(mesh.position.z)
      },
      geometry: {
        positions: [...positionAttr.array],
        normals: normalAttr ? [...normalAttr.array] : [],
        colors: colorAttr ? [...colorAttr.array] : [],
        uvs: uvAttr ? [...uvAttr.array] : [],
        indices: [...indexAttr.array]
      }
    })
  }

  const exportData: ExportedWorldGeometry = {
    version: worldRenderer.version ?? 'unknown',
    exportedAt: new Date().toISOString(),
    camera: {
      position: cameraPosition,
      rotation: cameraRotation
    },
    sections
  }

  // Optionally include texture atlas as data URL
  if (includeTexture && worldRenderer.material.map) {
    const canvas = document.createElement('canvas')
    const texture = worldRenderer.material.map
    const { image } = texture
    if (image) {
      canvas.width = image.width
      canvas.height = image.height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(image, 0, 0)
      exportData.textureAtlasDataUrl = canvas.toDataURL('image/png')
    }
  }

  return exportData
}

/**
 * Download world geometry as JSON file
 */
export function downloadWorldGeometry(
  worldRenderer: WorldRendererThree,
  cameraPosition: { x: number, y: number, z: number },
  cameraRotation: { pitch: number, yaw: number },
  filename = 'world-geometry.json',
  includeTexture = false
) {
  const exportData = exportWorldGeometry(worldRenderer, cameraPosition, cameraRotation, includeTexture)
  const json = JSON.stringify(exportData)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)

  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()

  URL.revokeObjectURL(url)
}

/**
 * Load world geometry from URL
 */
export async function loadWorldGeometryFromUrl(url: string): Promise<ExportedWorldGeometry> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch world geometry: ${response.statusText}`)
  }
  return response.json()
}

/**
 * Recreate THREE.js meshes from exported geometry
 * Returns an array of mesh groups that can be added to a scene
 */
function shaderMaterialForExport(legacyMaterial: THREE.Material): THREE.ShaderMaterial | null {
  const atlas = (legacyMaterial as THREE.MeshBasicMaterial).map
    ?? (legacyMaterial as THREE.MeshLambertMaterial).map
  if (!atlas) return null
  const shaderMat = createCubeBlockMaterial()
  shaderMat.uniforms.u_atlas.value = atlas
  const resources = getShaderCubeResources()
  if (!resources) return null
  const { tintPalette } = resources
  if (!tintPalette.isReady()) tintPalette.createTexture()
  shaderMat.uniforms.u_tintPalette.value = tintPalette.getTexture()
  return shaderMat
}

export function createMeshesFromExport(
  exportData: ExportedWorldGeometry,
  material: THREE.Material,
  shaderMaterial?: THREE.ShaderMaterial | null,
): THREE.Group[] {
  const groups: THREE.Group[] = []
  const resolvedShaderMat = shaderMaterial ?? shaderMaterialForExport(material)

  for (const section of exportData.sections) {
    const group = new THREE.Group()
    group.name = 'chunk'

    const hasLegacy = section.geometry.positions.length > 0 && section.geometry.indices.length > 0
    if (hasLegacy) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(section.geometry.positions, 3))
      if (section.geometry.normals.length) {
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(section.geometry.normals, 3))
      }
      if (section.geometry.colors.length) {
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(section.geometry.colors, 3))
      }
      if (section.geometry.uvs.length) {
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(section.geometry.uvs, 2))
      }
      const maxIndex = Math.max(...section.geometry.indices)
      const IndexArrayType = maxIndex > 65_535 ? Uint32Array : Uint16Array
      geometry.setIndex(new THREE.BufferAttribute(new IndexArrayType(section.geometry.indices), 1))
      const mesh = new THREE.Mesh(geometry, material)
      mesh.position.set(section.position.x, section.position.y, section.position.z)
      mesh.name = 'mesh'
      group.add(mesh)
    }

    const shaderCubes = section.shaderCubes
    if (shaderCubes && shaderCubes.count > 0 && resolvedShaderMat) {
      const shaderMesh = createShaderCubeMesh(shaderCubes, resolvedShaderMat)
      shaderMesh.position.set(section.position.x, section.position.y, section.position.z)
      group.add(shaderMesh)
    }

    if (group.children.length > 0) {
      groups.push(group)
    }
  }

  return groups
}

/**
 * Load texture from data URL and create THREE.js texture
 */
export async function loadTextureFromDataUrl(dataUrl: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const texture = new THREE.Texture(image)
      texture.magFilter = THREE.NearestFilter
      texture.minFilter = THREE.NearestFilter
      texture.needsUpdate = true
      texture.flipY = false
      resolve(texture)
    }
    image.onerror = reject
    image.src = dataUrl
  })
}

const disposeGeometryExportGroup = (group: THREE.Object3D) => {
  group.traverse(obj => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh
      mesh.geometry?.dispose()
    }
  })

  const material = group.userData?.geometryExportMaterial as THREE.Material | undefined
  if (material) {
    const texture = (material as THREE.MeshLambertMaterial).map
    texture?.dispose?.()
    material.dispose?.()
  }
}

/**
 * Apply exported geometry to an existing WorldRenderer instance.
 * Replaces any previously imported geometry export group.
 */
export async function applyWorldGeometryExport(
  worldRenderer: WorldRendererThree,
  exportData: ExportedWorldGeometry
): Promise<number> {
  const {
    scene,
    renderUpdateEmitter,
    material: rendererMaterial
  } = worldRenderer
  const existingGroup = scene.getObjectByName(GEOMETRY_EXPORT_GROUP_NAME)
  if (existingGroup) {
    scene.remove(existingGroup)
    disposeGeometryExportGroup(existingGroup)
  }

  const hasEmbeddedTexture = !!exportData.textureAtlasDataUrl
  let material: THREE.Material
  if (hasEmbeddedTexture && exportData.textureAtlasDataUrl) {
    const texture = await loadTextureFromDataUrl(exportData.textureAtlasDataUrl)
    material = new THREE.MeshLambertMaterial({
      map: texture,
      vertexColors: true,
      transparent: true,
      alphaTest: 0.1
    })
    material.name = 'geometry-export-material'
  } else {
    material = rendererMaterial
  }

  const shaderMat = exportData.sections.some(s => (s.shaderCubes?.count ?? 0) > 0)
    ? shaderMaterialForExport(material)
    : null
  const groups = createMeshesFromExport(exportData, material, shaderMat)
  const container = new THREE.Group()
  container.name = GEOMETRY_EXPORT_GROUP_NAME
  if (hasEmbeddedTexture) {
    container.userData.geometryExportMaterial = material
  }

  for (const group of groups) {
    container.add(group)
  }

  scene.add(container)
  renderUpdateEmitter.emit('update')

  return groups.length
}
