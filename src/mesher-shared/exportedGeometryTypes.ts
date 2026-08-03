/** Shared geometry export shapes (worker bridge + main-thread viewer). */

import { SHADER_CUBES_FORMAT_VERSION } from './shaderCubeFormat'

export interface ExportedSection {
  key: string
  position: { x: number; y: number; z: number }
  geometry: {
    positions: number[]
    normals: number[]
    colors: number[]
    skyLights: number[]
    blockLights: number[]
    uvs: number[]
    indices: number[]
  }
  blendGeometry?: {
    positions: number[]
    normals: number[]
    colors: number[]
    skyLights: number[]
    blockLights: number[]
    uvs: number[]
    indices: number[]
  }
  shaderCubes?: {
    words: Uint32Array
    count: number
    formatVersion: typeof SHADER_CUBES_FORMAT_VERSION
  }
  visibilitySet?: number
}

export interface ExportedWorldGeometry {
  version: string
  exportedAt: string
  camera: {
    position: { x: number; y: number; z: number }
    rotation: { pitch: number; yaw: number }
  }
  sections: ExportedSection[]
  textureAtlasDataUrl?: string
}
