import * as THREE from 'three'

/** Canvas used for item texture extraction (main thread or worker). */
export type ItemTextureCanvas = HTMLCanvasElement | OffscreenCanvas

function createItemTextureCanvas (width: number, height: number): ItemTextureCanvas {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    return canvas
  }
  return new OffscreenCanvas(width, height)
}

export interface Create3DItemMeshOptions {
  depth: number
  pixelSize?: number
}

export interface Create3DItemMeshResult {
  geometry: THREE.BufferGeometry
  totalVertices: number
  totalTriangles: number
}

/**
 * Creates a 3D item geometry with front/back faces and connecting edges
 * from a canvas containing the item texture
 */
export function create3DItemMesh (
  canvas: ItemTextureCanvas,
  options: Create3DItemMeshOptions
): Create3DItemMeshResult {
  const { depth, pixelSize } = options

  // Validate canvas dimensions
  if (canvas.width <= 0 || canvas.height <= 0) {
    throw new Error(`Invalid canvas dimensions: ${canvas.width}x${canvas.height}`)
  }

  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const { data } = imageData

  const w = canvas.width
  const h = canvas.height
  const halfDepth = depth / 2
  const actualPixelSize = pixelSize ?? (1 / Math.max(w, h))

  // Find opaque pixels
  const isOpaque = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false
    const i = (y * w + x) * 4
    return data[i + 3] > 128 // alpha > 128
  }

  const vertices: number[] = []
  const indices: number[] = []
  const uvs: number[] = []
  const normals: number[] = []

  let vertexIndex = 0

  // Helper to add a vertex
  const addVertex = (x: number, y: number, z: number, u: number, v: number, nx: number, ny: number, nz: number) => {
    vertices.push(x, y, z)
    uvs.push(u, v)
    normals.push(nx, ny, nz)
    return vertexIndex++
  }

  // Helper to add a quad (two triangles)
  const addQuad = (v0: number, v1: number, v2: number, v3: number) => {
    indices.push(v0, v1, v2, v0, v2, v3)
  }

  // Convert pixel coordinates to world coordinates
  const pixelToWorld = (px: number, py: number) => {
    const x = (px / w - 0.5) * actualPixelSize * w
    const y = -(py / h - 0.5) * actualPixelSize * h
    return { x, y }
  }

  // Create a grid of vertices for front and back faces
  const frontVertices: Array<Array<number | null>> = Array.from({ length: h + 1 }, () => Array.from({ length: w + 1 }, () => null))
  const backVertices: Array<Array<number | null>> = Array.from({ length: h + 1 }, () => Array.from({ length: w + 1 }, () => null))

  // Create vertices at pixel corners
  for (let py = 0; py <= h; py++) {
    for (let px = 0; px <= w; px++) {
      const { x, y } = pixelToWorld(px - 0.5, py - 0.5)

      // UV coordinates should map to the texture space of the extracted tile
      const u = px / w
      const v = py / h

      // Check if this vertex is needed for any face or edge
      let needVertex = false

      // Check all 4 adjacent pixels to see if any are opaque
      const adjacentPixels = [
        [px - 1, py - 1], // top-left pixel
        [px, py - 1], // top-right pixel
        [px - 1, py], // bottom-left pixel
        [px, py] // bottom-right pixel
      ]

      for (const [adjX, adjY] of adjacentPixels) {
        if (isOpaque(adjX, adjY)) {
          needVertex = true
          break
        }
      }

      if (needVertex) {
        frontVertices[py][px] = addVertex(x, y, halfDepth, u, v, 0, 0, 1)
        backVertices[py][px] = addVertex(x, y, -halfDepth, u, v, 0, 0, -1)
      }
    }
  }

  // Create front and back faces
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      if (!isOpaque(px, py)) continue

      const v00 = frontVertices[py][px]
      const v10 = frontVertices[py][px + 1]
      const v11 = frontVertices[py + 1][px + 1]
      const v01 = frontVertices[py + 1][px]

      const b00 = backVertices[py][px]
      const b10 = backVertices[py][px + 1]
      const b11 = backVertices[py + 1][px + 1]
      const b01 = backVertices[py + 1][px]

      if (v00 !== null && v10 !== null && v11 !== null && v01 !== null) {
        // Front face
        addQuad(v00, v10, v11, v01)
      }

      if (b00 !== null && b10 !== null && b11 !== null && b01 !== null) {
        // Back face (reversed winding)
        addQuad(b10, b00, b01, b11)
      }
    }
  }

  // Create edge faces for each side of the pixel with proper UVs
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      if (!isOpaque(px, py)) continue

      const pixelU = (px + 0.5) / w // Center of current pixel
      const pixelV = (py + 0.5) / h

      // Left edge (x = px)
      if (!isOpaque(px - 1, py)) {
        const f0 = frontVertices[py][px]
        const f1 = frontVertices[py + 1][px]
        const b0 = backVertices[py][px]
        const b1 = backVertices[py + 1][px]

        if (f0 !== null && f1 !== null && b0 !== null && b1 !== null) {
          // Create new vertices for edge with current pixel's UV
          const ef0 = addVertex(vertices[f0 * 3], vertices[f0 * 3 + 1], vertices[f0 * 3 + 2], pixelU, pixelV, -1, 0, 0)
          const ef1 = addVertex(vertices[f1 * 3], vertices[f1 * 3 + 1], vertices[f1 * 3 + 2], pixelU, pixelV, -1, 0, 0)
          const eb1 = addVertex(vertices[b1 * 3], vertices[b1 * 3 + 1], vertices[b1 * 3 + 2], pixelU, pixelV, -1, 0, 0)
          const eb0 = addVertex(vertices[b0 * 3], vertices[b0 * 3 + 1], vertices[b0 * 3 + 2], pixelU, pixelV, -1, 0, 0)
          addQuad(ef0, ef1, eb1, eb0)
        }
      }

      // Right edge (x = px + 1)
      if (!isOpaque(px + 1, py)) {
        const f0 = frontVertices[py + 1][px + 1]
        const f1 = frontVertices[py][px + 1]
        const b0 = backVertices[py + 1][px + 1]
        const b1 = backVertices[py][px + 1]

        if (f0 !== null && f1 !== null && b0 !== null && b1 !== null) {
          const ef0 = addVertex(vertices[f0 * 3], vertices[f0 * 3 + 1], vertices[f0 * 3 + 2], pixelU, pixelV, 1, 0, 0)
          const ef1 = addVertex(vertices[f1 * 3], vertices[f1 * 3 + 1], vertices[f1 * 3 + 2], pixelU, pixelV, 1, 0, 0)
          const eb1 = addVertex(vertices[b1 * 3], vertices[b1 * 3 + 1], vertices[b1 * 3 + 2], pixelU, pixelV, 1, 0, 0)
          const eb0 = addVertex(vertices[b0 * 3], vertices[b0 * 3 + 1], vertices[b0 * 3 + 2], pixelU, pixelV, 1, 0, 0)
          addQuad(ef0, ef1, eb1, eb0)
        }
      }

      // Top edge (y = py)
      if (!isOpaque(px, py - 1)) {
        const f0 = frontVertices[py][px]
        const f1 = frontVertices[py][px + 1]
        const b0 = backVertices[py][px]
        const b1 = backVertices[py][px + 1]

        if (f0 !== null && f1 !== null && b0 !== null && b1 !== null) {
          const ef0 = addVertex(vertices[f0 * 3], vertices[f0 * 3 + 1], vertices[f0 * 3 + 2], pixelU, pixelV, 0, -1, 0)
          const ef1 = addVertex(vertices[f1 * 3], vertices[f1 * 3 + 1], vertices[f1 * 3 + 2], pixelU, pixelV, 0, -1, 0)
          const eb1 = addVertex(vertices[b1 * 3], vertices[b1 * 3 + 1], vertices[b1 * 3 + 2], pixelU, pixelV, 0, -1, 0)
          const eb0 = addVertex(vertices[b0 * 3], vertices[b0 * 3 + 1], vertices[b0 * 3 + 2], pixelU, pixelV, 0, -1, 0)
          addQuad(ef0, ef1, eb1, eb0)
        }
      }

      // Bottom edge (y = py + 1)
      if (!isOpaque(px, py + 1)) {
        const f0 = frontVertices[py + 1][px + 1]
        const f1 = frontVertices[py + 1][px]
        const b0 = backVertices[py + 1][px + 1]
        const b1 = backVertices[py + 1][px]

        if (f0 !== null && f1 !== null && b0 !== null && b1 !== null) {
          const ef0 = addVertex(vertices[f0 * 3], vertices[f0 * 3 + 1], vertices[f0 * 3 + 2], pixelU, pixelV, 0, 1, 0)
          const ef1 = addVertex(vertices[f1 * 3], vertices[f1 * 3 + 1], vertices[f1 * 3 + 2], pixelU, pixelV, 0, 1, 0)
          const eb1 = addVertex(vertices[b1 * 3], vertices[b1 * 3 + 1], vertices[b1 * 3 + 2], pixelU, pixelV, 0, 1, 0)
          const eb0 = addVertex(vertices[b0 * 3], vertices[b0 * 3 + 1], vertices[b0 * 3 + 2], pixelU, pixelV, 0, 1, 0)
          addQuad(ef0, ef1, eb1, eb0)
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setIndex(indices)

  // Compute normals properly
  geometry.computeVertexNormals()

  return {
    geometry,
    totalVertices: vertexIndex,
    totalTriangles: indices.length / 3
  }
}

export interface ItemTextureInfo {
  u: number
  v: number
  sizeX: number
  sizeY: number
}

export interface ItemMeshResult {
  mesh: THREE.Object3D
  itemsTexture?: THREE.Texture
  itemsTextureFlipped?: THREE.Texture
  cleanup?: () => void
}

/**
 * Extracts item texture region to a canvas
 */
export function extractItemTextureToCanvas (
  sourceTexture: THREE.Texture<HTMLImageElement | ImageBitmap>,
  textureInfo: ItemTextureInfo
): ItemTextureCanvas {
  const { u, v, sizeX, sizeY } = textureInfo

  // Calculate canvas size - fix the calculation
  const canvasWidth = Math.max(1, Math.floor(sizeX * sourceTexture.image.width))
  const canvasHeight = Math.max(1, Math.floor(sizeY * sourceTexture.image.height))

  const canvas = createItemTextureCanvas(canvasWidth, canvasHeight)
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!ctx) {
    throw new Error('Failed to get 2d context for item texture canvas')
  }
  ctx.imageSmoothingEnabled = false

  // Draw the item texture region to canvas
  ctx.drawImage(
    sourceTexture.image,
    u * sourceTexture.image.width,
    v * sourceTexture.image.height,
    sizeX * sourceTexture.image.width,
    sizeY * sourceTexture.image.height,
    0,
    0,
    canvas.width,
    canvas.height
  )

  return canvas
}

/**
 * Creates either a 2D or 3D item mesh based on parameters
 */
export function createItemMesh (
  sourceTexture: THREE.Texture,
  textureInfo: ItemTextureInfo,
  options: {
    faceCamera?: boolean
    use3D?: boolean
    depth?: number
  } = {}
): ItemMeshResult {
  const { faceCamera = false, use3D = true, depth = 0.04 } = options
  const { u, v, sizeX, sizeY } = textureInfo

  if (faceCamera) {
    // Create sprite for camera-facing items
    const itemsTexture = sourceTexture.clone()
    itemsTexture.flipY = true
    itemsTexture.offset.set(u, 1 - v - sizeY)
    itemsTexture.repeat.set(sizeX, sizeY)
    itemsTexture.needsUpdate = true
    itemsTexture.magFilter = THREE.NearestFilter
    itemsTexture.minFilter = THREE.NearestFilter

    const spriteMat = new THREE.SpriteMaterial({
      map: itemsTexture,
      transparent: true,
      alphaTest: 0.1,
    })
    const mesh = new THREE.Sprite(spriteMat)

    return {
      mesh,
      itemsTexture,
      cleanup () {
        itemsTexture.dispose()
      }
    }
  }

  if (use3D) {
    // Try to create 3D mesh
    try {
      const canvas = extractItemTextureToCanvas(
        sourceTexture as THREE.Texture<HTMLImageElement | ImageBitmap>,
        textureInfo
      )
      const { geometry } = create3DItemMesh(canvas, { depth })

      // Create texture from canvas for the 3D mesh
      const itemsTexture = new THREE.CanvasTexture(canvas)
      itemsTexture.magFilter = THREE.NearestFilter
      itemsTexture.minFilter = THREE.NearestFilter
      itemsTexture.wrapS = itemsTexture.wrapT = THREE.ClampToEdgeWrapping
      itemsTexture.flipY = false
      itemsTexture.needsUpdate = true

      const material = new THREE.MeshStandardMaterial({
        map: itemsTexture,
        side: THREE.DoubleSide,
        transparent: true,
        alphaTest: 0.1,
      })

      const mesh = new THREE.Mesh(geometry, material)

      return {
        mesh,
        itemsTexture,
        cleanup () {
          itemsTexture.dispose()
          geometry.dispose()
          if (material.map) material.map.dispose()
          material.dispose()
        }
      }
    } catch (error) {
      console.warn('Failed to create 3D item mesh, falling back to 2D:', error)
      // Fall through to 2D rendering
    }
  }

  // Fallback to 2D flat rendering
  const itemsTexture = sourceTexture.clone()
  itemsTexture.flipY = true
  itemsTexture.offset.set(u, 1 - v - sizeY)
  itemsTexture.repeat.set(sizeX, sizeY)
  itemsTexture.needsUpdate = true
  itemsTexture.magFilter = THREE.NearestFilter
  itemsTexture.minFilter = THREE.NearestFilter

  const itemsTextureFlipped = itemsTexture.clone()
  itemsTextureFlipped.repeat.x *= -1
  itemsTextureFlipped.needsUpdate = true
  itemsTextureFlipped.offset.set(u + sizeX, 1 - v - sizeY)

  const material = new THREE.MeshStandardMaterial({
    map: itemsTexture,
    transparent: true,
    alphaTest: 0.1,
  })
  const materialFlipped = new THREE.MeshStandardMaterial({
    map: itemsTextureFlipped,
    transparent: true,
    alphaTest: 0.1,
  })
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0), [
    new THREE.MeshBasicMaterial({ color: 0x00_00_00 }), new THREE.MeshBasicMaterial({ color: 0x00_00_00 }),
    new THREE.MeshBasicMaterial({ color: 0x00_00_00 }), new THREE.MeshBasicMaterial({ color: 0x00_00_00 }),
    material, materialFlipped,
  ])

  return {
    mesh,
    itemsTexture,
    itemsTextureFlipped,
    cleanup () {
      itemsTexture.dispose()
      itemsTextureFlipped.dispose()
      material.dispose()
      materialFlipped.dispose()
    }
  }
}

/**
 * Creates a complete 3D item mesh from a canvas texture
 */
export function createItemMeshFromCanvas (
  canvas: HTMLCanvasElement,
  options: Create3DItemMeshOptions
): THREE.Mesh {
  const { geometry } = create3DItemMesh(canvas, options)

  // Base color texture for the item
  const colorTexture = new THREE.CanvasTexture(canvas)
  colorTexture.magFilter = THREE.NearestFilter
  colorTexture.minFilter = THREE.NearestFilter
  colorTexture.wrapS = colorTexture.wrapT = THREE.ClampToEdgeWrapping
  colorTexture.flipY = false // Important for canvas textures
  colorTexture.needsUpdate = true

  // Material - no transparency, no alpha test needed for edges
  const material = new THREE.MeshBasicMaterial({
    map: colorTexture,
    side: THREE.DoubleSide,
    transparent: true,
    alphaTest: 0.1
  })

  return new THREE.Mesh(geometry, material)
}
