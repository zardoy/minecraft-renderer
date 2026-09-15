/**
 * TSL side of the per-face UV table. Kept separate from `faceTables.ts` so the WebGL
 * shader can import the raw tables without pulling the TSL/WebGPU bundle in.
 *
 * Generated from the same FACE_UV_TERMS as `buildFaceUvGlsl()`, so the WebGL and WebGPU
 * cube shaders cannot disagree about face orientation.
 */

import { select, int, float, vec2 } from 'three/tsl'
import { FACE_UV_TERMS, type FaceUvTerm } from './faceTables'

/** Maps a UV term to its TSL expression given quad-corner coords u, v ∈ {0,1}. */
function tslTerm(t: FaceUvTerm, u: any, v: any) {
  switch (t) {
    case 'u':
      return u
    case 'v':
      return v
    case '1-u':
      return float(1).sub(u)
    case '1-v':
      return float(1).sub(v)
  }
}

/**
 * Per-face tile-local UV as a TSL vec2.
 *
 * @param faceId int node (0..5)
 * @param u      float node, quad corner u ∈ {0,1}
 * @param v      float node, quad corner v ∈ {0,1}
 */
export function faceUvTsl(faceId: any, u: any, v: any) {
  const last = FACE_UV_TERMS[FACE_UV_TERMS.length - 1]
  let node: any = vec2(tslTerm(last[0], u, v), tslTerm(last[1], u, v))
  for (let i = FACE_UV_TERMS.length - 2; i >= 0; i--) {
    const [ut, vt] = FACE_UV_TERMS[i]
    node = select(faceId.equal(int(i)), vec2(tslTerm(ut, u, v), tslTerm(vt, u, v)), node)
  }
  return node
}
