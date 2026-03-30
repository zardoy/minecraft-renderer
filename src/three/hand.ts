import * as THREE from 'three'
import { loadSkinFromUsername, loadSkinImage } from '../lib/utils/skins'
import { steveTexture } from './entities'


export const getMyHand = async (image?: string, userName?: string) => {
  let newMap: THREE.Texture
  if (!image && !userName) {
    newMap = await steveTexture
  } else {
    if (!image) {
      image = await loadSkinFromUsername(userName!, 'skin')
    }
    if (!image) {
      return
    }
    const { canvas } = await loadSkinImage(image)
    newMap = new THREE.CanvasTexture(canvas)
  }

  newMap.magFilter = THREE.NearestFilter
  newMap.minFilter = THREE.NearestFilter

  const slim = false
  const pixelWidth = slim ? 3 : 4

  // Exact replica of vanilla's Cube: addBox(-3, -2, -2, 4, 12, 4) at texOffs(40, 16)
  const box = createVanillaCubeGeometry(
    40, 16,
    slim ? -2 : -3, -2, -2,
    pixelWidth, 12, 4,
    64, 64
  )

  const material = new THREE.MeshStandardMaterial()
  material.map = newMap
  material.needsUpdate = true

  const mesh = new THREE.Mesh(box, material)

  const group = new THREE.Group()
  group.add(mesh)
  return group
}

/**
 * Creates a BufferGeometry replicating vanilla Minecraft's ModelPart.Cube exactly.
 * Vertices, face winding, normals, and UV mapping match the decompiled Java source.
 * Position coordinates are in pixels, divided by 16 for block units.
 */
function createVanillaCubeGeometry (
  texU: number, texV: number,
  originX: number, originY: number, originZ: number,
  sizeX: number, sizeY: number, sizeZ: number,
  texWidth: number, texHeight: number,
  mirror = false
): THREE.BufferGeometry {
  let minX = originX / 16
  let minY = originY / 16
  let minZ = originZ / 16
  let maxX = (originX + sizeX) / 16
  let maxY = (originY + sizeY) / 16
  let maxZ = (originZ + sizeZ) / 16

  if (mirror) {
    [minX, maxX] = [maxX, minX]
  }

  // 8 corner vertices matching vanilla's Cube constructor
  const V = [
    [minX, minY, minZ], // 0
    [maxX, minY, minZ], // 1
    [maxX, maxY, minZ], // 2
    [minX, maxY, minZ], // 3
    [minX, minY, maxZ], // 4
    [maxX, minY, maxZ], // 5
    [maxX, maxY, maxZ], // 6
    [minX, maxY, maxZ], // 7
  ]

  // UV grid (pixel coords)
  const u0 = texU
  const u1 = texU + sizeZ
  const u2 = texU + sizeZ + sizeX
  const u3 = texU + sizeZ + sizeX + sizeX
  const u4 = texU + sizeZ + sizeX + sizeZ
  const u5 = texU + sizeZ + sizeX + sizeZ + sizeX
  const v0 = texV
  const v1 = texV + sizeZ
  const v2 = texV + sizeZ + sizeY

  // 6 faces: vanilla vertex order + UV rect + normal
  const faces: { vi: number[]; uv: number[]; n: number[] }[] = [
    { vi: [5, 4, 0, 1], uv: [u1, v0, u2, v1], n: [0, -1, 0] },  // DOWN
    { vi: [2, 3, 7, 6], uv: [u2, v1, u3, v0], n: [0, 1, 0] },   // UP
    { vi: [0, 4, 7, 3], uv: [u0, v1, u1, v2], n: [-1, 0, 0] },  // WEST
    { vi: [1, 0, 3, 2], uv: [u1, v1, u2, v2], n: [0, 0, -1] },  // NORTH
    { vi: [5, 1, 2, 6], uv: [u2, v1, u4, v2], n: [1, 0, 0] },   // EAST
    { vi: [4, 5, 6, 7], uv: [u4, v1, u5, v2], n: [0, 0, 1] },   // SOUTH
  ]

  const positions: number[] = []
  const uvs: number[] = []
  const normals: number[] = []
  const indices: number[] = []

  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi]
    const base = fi * 4

    const [uL, vT, uR, vB] = face.uv
    // Vanilla vertex UV order: top-right, top-left, bottom-left, bottom-right
    const fUV = [
      [uR / texWidth, 1 - vT / texHeight],
      [uL / texWidth, 1 - vT / texHeight],
      [uL / texWidth, 1 - vB / texHeight],
      [uR / texWidth, 1 - vB / texHeight],
    ]

    const order = mirror ? [3, 2, 1, 0] : [0, 1, 2, 3]
    const nx = mirror ? -face.n[0] : face.n[0]

    for (let i = 0; i < 4; i++) {
      const vert = V[face.vi[order[i]]]
      positions.push(vert[0], vert[1], vert[2])
      uvs.push(fUV[i][0], fUV[i][1])
      normals.push(nx, face.n[1], face.n[2])
    }

    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setIndex(indices)

  return geometry
}
