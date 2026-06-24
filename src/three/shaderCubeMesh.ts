import * as THREE from 'three'
import { VERTICES_PER_FACE } from './shaders/cubeBlockShader'
import { SHADER_CUBES_WORDS_PER_FACE } from '../wasm-mesher/bridge/shaderCubeBridge'

export type ShaderCubeInstanceData = {
  words: Uint32Array
  count: number
}

/**
 * Build InstancedBufferGeometry for full-cube shader faces.
 * One instance = one visible face; vertex shader uses gl_VertexID (6 verts/face).
 */
export function buildShaderCubeGeometry(words: Uint32Array, faceCount: number): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry()

  const positions = new Float32Array(VERTICES_PER_FACE * 3)
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))

  const w0 = new Uint32Array(faceCount)
  const w1 = new Uint32Array(faceCount)
  const w2 = new Uint32Array(faceCount)
  const w3 = new Uint32Array(faceCount)
  const stride = SHADER_CUBES_WORDS_PER_FACE
  for (let i = 0; i < faceCount; i++) {
    w0[i] = words[i * stride]!
    w1[i] = words[i * stride + 1]!
    w2[i] = words[i * stride + 2]!
    w3[i] = words[i * stride + 3]!
  }

  geometry.setAttribute('a_w0', new THREE.InstancedBufferAttribute(w0, 1))
  geometry.setAttribute('a_w1', new THREE.InstancedBufferAttribute(w1, 1))
  geometry.setAttribute('a_w2', new THREE.InstancedBufferAttribute(w2, 1))
  geometry.setAttribute('a_w3', new THREE.InstancedBufferAttribute(w3, 1))

  geometry.instanceCount = faceCount
  geometry.boundingBox = new THREE.Box3(new THREE.Vector3(-8, -8, -8), new THREE.Vector3(8, 8, 8))
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), Math.sqrt(3 * 8 ** 2))

  return geometry
}

const _raycastBox = new THREE.Box3()
const _raycastPoint = new THREE.Vector3()

/**
 * CPU raycast uses section AABB (geometry.boundingBox), not GPU-generated faces.
 * Enough for third-person camera collision; block pick uses mineflayer, not mesh raycast.
 */
export function attachShaderCubeRaycast(mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material>): void {
  mesh.raycast = (raycaster, intersects) => {
    const { geometry } = mesh
    if (!geometry.boundingBox) return
    _raycastBox.copy(geometry.boundingBox).applyMatrix4(mesh.matrixWorld)
    if (!raycaster.ray.intersectBox(_raycastBox, _raycastPoint)) return
    const distance = raycaster.ray.origin.distanceTo(_raycastPoint)
    intersects.push({
      distance,
      point: _raycastPoint.clone(),
      object: mesh
    })
  }
}

export function createShaderCubeMesh(
  data: ShaderCubeInstanceData,
  material: THREE.ShaderMaterial
): THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial> {
  const geometry = buildShaderCubeGeometry(data.words, data.count)
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'shaderMesh'
  mesh.matrixAutoUpdate = false
  mesh.frustumCulled = false
  attachShaderCubeRaycast(mesh)
  return mesh
}

export function disposeShaderCubeMesh(mesh: THREE.Mesh): void {
  mesh.geometry.dispose()
}
