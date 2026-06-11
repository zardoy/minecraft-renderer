/** Shared geometry export shapes (worker bridge + main-thread viewer). */

export interface ExportedSection {
  key: string
  position: { x: number, y: number, z: number }
  geometry: {
    positions: number[]
    normals: number[]
    colors: number[]
    uvs: number[]
    indices: number[]
  }
  blendGeometry?: {
    positions: number[]
    normals: number[]
    colors: number[]
    uvs: number[]
    indices: number[]
  }
  shaderCubes?: {
    words: Uint32Array
    count: number
    formatVersion: 2
  }
}

export interface ExportedWorldGeometry {
  version: string
  exportedAt: string
  camera: {
    position: { x: number, y: number, z: number }
    rotation: { pitch: number, yaw: number }
  }
  sections: ExportedSection[]
  textureAtlasDataUrl?: string
}
