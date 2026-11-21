/**
 * Face geometry + UV tables — single source of truth for the WebGL (GLSL) and
 * WebGPU (TSL) cube shaders.
 *
 * These used to be GLSL-only literals inside cubeBlockShader.ts with a "GLSL cannot
 * import them" comment. TSL *can* import them, so the tables live here and the GLSL
 * arrays are generated from them; editing one path can no longer silently desync the other.
 *
 * This module is intentionally **free of any TSL/three import** so that pulling it into
 * the WebGL shader does not drag the WebGPU node bundle along. The TSL side lives in
 * `faceUvTsl.ts`.
 *
 * Face order: UP=0, DOWN=1, EAST=2, WEST=3, SOUTH=4, NORTH=5 (matches mesher.rs FACE_NAMES).
 */

export type Vec3Tuple = readonly [number, number, number]

/** position = BASE[faceId] + u * DU[faceId] + v * DV[faceId] */
export const FACE_BASE: readonly Vec3Tuple[] = [
  [0, 1, 1], // UP    (+Y)
  [1, 0, 1], // DOWN  (-Y)
  [1, 1, 1], // EAST  (+X)
  [0, 1, 0], // WEST  (-X)
  [0, 1, 1], // SOUTH (+Z)
  [1, 1, 0] // NORTH (-Z)
]

export const FACE_DU: readonly Vec3Tuple[] = [
  [1, 0, 0], // UP
  [-1, 0, 0], // DOWN
  [0, -1, 0], // EAST
  [0, -1, 0], // WEST
  [1, 0, 0], // SOUTH
  [-1, 0, 0] // NORTH
]

export const FACE_DV: readonly Vec3Tuple[] = [
  [0, 0, -1], // UP
  [0, 0, -1], // DOWN
  [0, 0, -1], // EAST
  [0, 0, 1], // WEST
  [0, -1, 0], // SOUTH
  [0, -1, 0] // NORTH
]

export const FACE_NORMAL: readonly Vec3Tuple[] = [
  [0, 1, 0], // UP
  [0, -1, 0], // DOWN
  [1, 0, 0], // EAST
  [-1, 0, 0], // WEST
  [0, 0, 1], // SOUTH
  [0, 0, -1] // NORTH
]

/**
 * Per-(triangle, corner) -> quad corner index (vi), one table per diagonal mode.
 * Normal: T0=[0,1,2], T1=[2,1,3]. Flipped: T0=[0,3,2], T1=[0,1,3].
 */
export const VI_NORMAL: readonly number[] = [0, 1, 2, 2, 1, 3]
export const VI_FLIPPED: readonly number[] = [0, 3, 2, 0, 1, 3]

// ---------------------------------------------------------------------------
// Per-face UV
// ---------------------------------------------------------------------------

/** Term of tile-local UV in quad-corner coordinates (u, v ∈ {0,1}). */
export type FaceUvTerm = 'u' | '1-u' | 'v' | '1-v'

/**
 * Canonical tile-local UV per face for su>0, sv>0. Matches legacy elemFaces
 * (+ implicit +180° on down; see render-from-wasm.ts `r += 180`).
 * Index = faceId: UP, DOWN, EAST, WEST, SOUTH, NORTH.
 */
export const FACE_UV_TERMS: ReadonlyArray<readonly [FaceUvTerm, FaceUvTerm]> = [
  ['u', '1-v'], // UP
  ['1-u', 'v'], // DOWN
  ['v', 'u'], // EAST
  ['v', 'u'], // WEST
  ['u', 'v'], // SOUTH
  ['1-u', 'v'] // NORTH
]

export function evalFaceUvTerm(t: FaceUvTerm, cu: number, cv: number): number {
  switch (t) {
    case 'u':
      return cu
    case '1-u':
      return 1 - cu
    case 'v':
      return cv
    case '1-v':
      return 1 - cv
  }
}

/** vi — quad corner in shader order (0..3): u = vi & 1, v = (vi >> 1) & 1. */
export function shaderCubeFaceUv(faceId: number, vi: number, flipU: boolean, flipV: boolean): [number, number] {
  const [ut, vt] = FACE_UV_TERMS[faceId] ?? FACE_UV_TERMS[0]
  const cu = vi & 1
  const cv = (vi >> 1) & 1
  let uLocal = evalFaceUvTerm(ut, cu, cv)
  let vLocal = evalFaceUvTerm(vt, cu, cv)
  if (flipU) uLocal = 1 - uLocal
  if (flipV) vLocal = 1 - vLocal
  return [uLocal, vLocal]
}

// ---------------------------------------------------------------------------
// GLSL emission (consumed by the WebGL cube shader)
// ---------------------------------------------------------------------------

const glslTerm = (t: FaceUvTerm) =>
  ({
    u: 'u',
    v: 'v',
    '1-u': '1.0 - u',
    '1-v': '1.0 - v'
  })[t]

/** GLSL if/else-if chain for per-face UV — generated from FACE_UV_TERMS. */
export function buildFaceUvGlsl(): string {
  return FACE_UV_TERMS.map(([ut, vt], i) => `    ${i === 0 ? 'if' : 'else if'} (faceId == ${i}u) uv = vec2(${glslTerm(ut)}, ${glslTerm(vt)});`).join('\n')
}

const glslVec3 = (v: Vec3Tuple) => `vec3(${v.map(n => n.toFixed(1)).join(', ')})`

export function emitVec3ArrayGlsl(name: string, table: readonly Vec3Tuple[]): string {
  return `const vec3 ${name}[6] = vec3[6](\n${table.map(v => `    ${glslVec3(v)}`).join(',\n')}\n);`
}

export function emitIntArrayGlsl(name: string, table: readonly number[]): string {
  return `const int ${name}[6] = int[6](${table.join(', ')});`
}
