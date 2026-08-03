import { test, expect, beforeEach, vi } from 'vitest'
import * as THREE from 'three'
import { elemFaces } from '../../mesher-shared/modelsGeometryCommon'
import { SHADER_CUBES_FORMAT_VERSION } from '../../mesher-shared/shaderCubeFormat'
import { FACE_UV_TERMS, buildFaceUvGlsl, shaderCubeFaceUv, cubeBlockVertexShader, WORD0, WORD2 } from '../../three/shaders/cubeBlockShader'
import {
  AO_LIGHT_REMAP,
  resetShaderCubeResources,
  getShaderCubeResources,
  resolveFaceUv,
  isShaderCubeBlock,
  tryBuildShaderCubeInstances,
  SHADER_CUBES_WORDS_PER_FACE
} from '../bridge/shaderCubeBridge'
import { createMeshesFromExport } from '../../three/worldGeometryExport'

const FACE_NAMES = ['up', 'down', 'east', 'west', 'south', 'north'] as const
const SIGN_COMBOS: Array<[boolean, boolean]> = [
  [false, false],
  [true, false],
  [false, true],
  [true, true]
]

function requireShaderCubeResources() {
  const resources = getShaderCubeResources()
  if (!resources) throw new Error('shader cube resources unavailable in test')
  return resources
}

/** Legacy tile-local UV (render-from-wasm.ts elemFaces + down +180°). */
function legacyTileLocalUv(faceName: string, cornerIdx: number, suSign: number, svSign: number): [number, number] {
  const [, , , cu, cv] = (elemFaces as Record<string, { corners: number[][] }>)[faceName]!.corners[cornerIdx]!
  const r = faceName === 'down' ? 180 : 0
  const uvcs = Math.cos((r * Math.PI) / 180)
  const uvsn = -Math.sin((r * Math.PI) / 180)
  const baseu = (cu - 0.5) * uvcs - (cv - 0.5) * uvsn + 0.5
  const basev = (cu - 0.5) * uvsn + (cv - 0.5) * uvcs + 0.5
  return [suSign < 0 ? 1 - baseu : baseu, svSign < 0 ? 1 - basev : basev]
}

beforeEach(() => {
  resetShaderCubeResources()
})

test('shaderCubeFaceUv: 6 faces × 4 corners × 4 sign combos match legacy (96 cases)', () => {
  for (let faceIdx = 0; faceIdx < 6; faceIdx++) {
    const faceName = FACE_NAMES[faceIdx]!
    for (let vi = 0; vi < 4; vi++) {
      for (const [flipU, flipV] of SIGN_COMBOS) {
        const suSign = flipU ? -1 : 1
        const svSign = flipV ? -1 : 1
        const elemCorner = AO_LIGHT_REMAP[faceIdx]![vi]!
        const legacy = legacyTileLocalUv(faceName, elemCorner, suSign, svSign)
        const shader = shaderCubeFaceUv(faceIdx, vi, flipU, flipV)
        expect(shader[0]).toBeCloseTo(legacy[0], 9)
        expect(shader[1]).toBeCloseTo(legacy[1], 9)
      }
    }
  }
})

test('buildFaceUvGlsl: 6 branches match FACE_UV_TERMS and vertex shader embeds generated table', () => {
  const glsl = buildFaceUvGlsl()
  for (let i = 0; i < 6; i++) {
    expect(glsl).toContain(`faceId == ${i}u`)
    const [ut, vt] = FACE_UV_TERMS[i]!
    const glslU = ut === 'u' ? 'u' : ut === 'v' ? 'v' : ut === '1-u' ? '1.0 - u' : '1.0 - v'
    const glslV = vt === 'u' ? 'u' : vt === 'v' ? 'v' : vt === '1-u' ? '1.0 - u' : '1.0 - v'
    expect(glsl).toContain(`vec2(${glslU}, ${glslV})`)
  }
  expect(cubeBlockVertexShader).toContain(glsl)
  expect(cubeBlockVertexShader).toContain('a_w2 >> 31u')
  expect(cubeBlockVertexShader).toContain('a_w0 >> 31u')
})

test('resolveFaceUv: crafting_table north/west regression', () => {
  const { textureIndexMapping } = requireShaderCubeResources()

  const north = resolveFaceUv({ u: 0.53125, v: 0, su: -0.015625, sv: 0.015625, tileIndex: 33 }, textureIndexMapping)
  expect(north).toEqual({ tileIndex: 33, flipU: true, flipV: false })

  const west = resolveFaceUv({ u: 0.515625, v: 0, su: 0.015625, sv: 0.015625, tileIndex: 33 }, textureIndexMapping)
  expect(west).toEqual({ tileIndex: 33, flipU: false, flipV: false })
})

test('tryBuildShaderCubeInstances: crafting_table north sets FLIP_U_SHIFT', () => {
  const { textureIndexMapping, tintPalette } = requireShaderCubeResources()
  const craftingFaces = {
    up: { texture: { u: 0.515625, v: 0, su: 0.015625, sv: 0.015625, tileIndex: 33 } },
    down: { texture: { u: 0.53125, v: 0, su: -0.015625, sv: 0.015625, tileIndex: 33 } },
    east: { texture: { u: 0.515625, v: 0, su: 0.015625, sv: 0.015625, tileIndex: 33 } },
    west: { texture: { u: 0.515625, v: 0, su: 0.015625, sv: 0.015625, tileIndex: 33 } },
    south: { texture: { u: 0.515625, v: 0, su: 0.015625, sv: 0.015625, tileIndex: 33 } },
    north: { texture: { u: 0.53125, v: 0, su: -0.015625, sv: 0.015625, tileIndex: 33 } }
  }
  const model = { elements: [{ faces: craftingFaces }] }
  const block = {
    position: [0, 0, 0] as [number, number, number],
    visible_faces: 1 << 5,
    ao_data: [[3, 3, 3, 3]],
    light_combined: [[255, 255, 255, 255]]
  }
  const words: number[] = []
  const ok = tryBuildShaderCubeInstances(
    block,
    { blockName: 'crafting_table', blockProps: {}, isCube: true, model },
    model,
    { sectionOrigin: { x: 0, y: 0, z: 0 }, sectionHeight: 16, tintPalette, textureIndexMapping },
    words
  )
  expect(ok).toBe(true)
  expect(words.length).toBe(SHADER_CUBES_WORDS_PER_FACE)
  expect(words[2]! & (1 << WORD2.FLIP_U_SHIFT)).not.toBe(0)
})

test('tryBuildShaderCubeInstances: sv<0 up face sets FLIP_V_SHIFT', () => {
  const { textureIndexMapping, tintPalette } = requireShaderCubeResources()
  const stdFace = { u: 0, v: 0, su: 16, sv: 16 }
  const upSvNeg = { u: 0.515625, v: 0.015625, su: 0.015625, sv: -0.015625, tileIndex: 33 }
  expect(resolveFaceUv(upSvNeg, textureIndexMapping)).toEqual({ tileIndex: 33, flipU: false, flipV: true })

  const model = {
    elements: [
      {
        faces: {
          up: { texture: upSvNeg },
          down: { texture: stdFace },
          east: { texture: stdFace },
          west: { texture: stdFace },
          south: { texture: stdFace },
          north: { texture: stdFace }
        }
      }
    ]
  }
  const block = {
    position: [0, 0, 0] as [number, number, number],
    visible_faces: 1 << 0,
    ao_data: [[3, 3, 3, 3]],
    light_combined: [[255, 255, 255, 255]]
  }
  const words: number[] = []
  const ok = tryBuildShaderCubeInstances(
    block,
    { blockName: 'observer', blockProps: { facing: 'north' }, isCube: true, model },
    model,
    { sectionOrigin: { x: 0, y: 0, z: 0 }, sectionHeight: 16, tintPalette, textureIndexMapping },
    words
  )
  expect(ok).toBe(true)
  expect(words.length).toBe(SHADER_CUBES_WORDS_PER_FACE)
  expect(words[0]! & (1 << WORD0.FLIP_V_SHIFT)).not.toBe(0)
  expect(words[2]! & (1 << WORD2.FLIP_U_SHIFT)).toBe(0)
})

test('resolveFaceUv gate: rejects crop, non-integer scale, misaligned tile, tileIndex mismatch, NaN', () => {
  const { textureIndexMapping } = requireShaderCubeResources()

  expect(resolveFaceUv({ u: 0, v: 0, su: 8, sv: 16 }, textureIndexMapping)).toBeNull()
  expect(resolveFaceUv({ u: 0, v: 0, su: 15.6, sv: 16 }, textureIndexMapping)).toBeNull()
  expect(resolveFaceUv({ u: 529, v: 0, su: 16, sv: 16 }, textureIndexMapping)).toBeNull()
  expect(resolveFaceUv({ u: 0, v: 0, su: 16, sv: 16, tileIndex: 999 }, textureIndexMapping)).toBeNull()
  expect(resolveFaceUv({ u: 0, v: 0, su: Number.NaN, sv: 16 }, textureIndexMapping)).toBeNull()
})

test('isShaderCubeBlock: rejects faces that fail resolveFaceUv gate', () => {
  const { textureIndexMapping } = requireShaderCubeResources()
  const baseFaces = {
    up: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
    down: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
    east: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
    west: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
    south: { texture: { u: 0, v: 0, su: 16, sv: 16 } },
    north: { texture: { u: 0, v: 0, su: 16, sv: 16 } }
  }
  const model = { elements: [{ faces: baseFaces }] }
  expect(isShaderCubeBlock({ blockName: 'stone', blockProps: {}, isCube: true, model }, model, 16, textureIndexMapping)).toBe(true)

  const cropped = {
    elements: [{ faces: { ...baseFaces, up: { texture: { u: 0, v: 0, su: 8, sv: 16 } } } }]
  }
  expect(isShaderCubeBlock({ blockName: 'stone', blockProps: {}, isCube: true, model: cropped }, cropped, 16, textureIndexMapping)).toBe(false)
})

test('createMeshesFromExport: skips shader-cube sections with old formatVersion', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const material = new THREE.MeshBasicMaterial()
  const v3Words = new Uint32Array([1, 2, 3, 4])
  const v4Words = new Uint32Array([5, 6, 7, 8])

  const groups = createMeshesFromExport(
    {
      version: 'test',
      exportedAt: '',
      camera: { position: { x: 0, y: 0, z: 0 }, rotation: { pitch: 0, yaw: 0 } },
      sections: [
        {
          key: 'old',
          position: { x: 0, y: 0, z: 0 },
          geometry: { positions: [], normals: [], colors: [], skyLights: [], blockLights: [], uvs: [], indices: [] },
          shaderCubes: { words: v3Words, count: 1, formatVersion: 3 as unknown as typeof SHADER_CUBES_FORMAT_VERSION }
        },
        {
          key: 'new',
          position: { x: 16, y: 0, z: 0 },
          geometry: { positions: [], normals: [], colors: [], skyLights: [], blockLights: [], uvs: [], indices: [] },
          shaderCubes: { words: v4Words, count: 1, formatVersion: SHADER_CUBES_FORMAT_VERSION }
        }
      ]
    },
    material,
    new THREE.ShaderMaterial({ vertexShader: 'void main() {}', fragmentShader: 'void main() {}' })
  )

  expect(groups).toHaveLength(1)
  expect(groups[0]!.children).toHaveLength(1)
  expect(warn).toHaveBeenCalledOnce()
  expect(warn.mock.calls[0]![0]).toContain('Skipped 1 shader-cube section')
  expect(warn.mock.calls[0]![0]).toContain('3')
  expect(warn.mock.calls[0]![0]).toContain(String(SHADER_CUBES_FORMAT_VERSION))

  warn.mockRestore()
  material.dispose()
})
