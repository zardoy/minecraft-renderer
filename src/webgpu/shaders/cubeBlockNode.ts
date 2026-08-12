/**
 * TSL port of `three/shaders/cubeBlockShader.ts` (GLSL3) for the WebGPU backend.
 *
 * Differences from the WebGL path, all deliberate:
 *
 *  - Face words are read from a **storage buffer** as `uvec4` (interleaved, exactly the
 *    layout the mesher already emits) instead of 4 planar instanced attributes. The
 *    WebGL path de-interleaves on the CPU; here we upload the mesher output as-is.
 *  - The instance index is an indirection through `visibleFaces`, a compacted list
 *    produced by the culling compute pass, so the draw is a single `drawIndirect`.
 *  - Geometry/UV tables are imported from `faceTables.ts` rather than duplicated as
 *    GLSL literals.
 *
 * Bit layout is shared with the WebGL path via WORD0..WORD3 from cubeBlockShader.ts —
 * the one thing that must never diverge.
 */

import * as THREE from 'three/webgpu'
import {
  Fn,
  If,
  Discard,
  vec2,
  vec3,
  vec4,
  ivec2,
  int,
  uint,
  float,
  uniform,
  texture,
  instanceIndex,
  vertexIndex,
  cameraProjectionMatrix,
  modelViewMatrix,
  select,
  mix,
  max,
  min,
  abs,
  clamp,
  pow,
  exp,
  smoothstep,
  fract,
  log2
} from 'three/tsl'

import { WORD0, WORD1, WORD2, WORD3 } from '../../three/shaders/cubeBlockShader'
import { FACE_BASE, FACE_DU, FACE_DV, FACE_NORMAL, VI_NORMAL, VI_FLIPPED } from './faceTables'
import { faceUvTsl } from './faceUvTsl'
import { storageTyped, ivec2n } from './tslCompat'
import { DEFAULT_LIGHTMAP_PARAMS, type BlockLightmapParams } from '../../lib/blockEntityLighting'

export const VERTICES_PER_FACE = 6

/** Uniforms mirrored from the GLSL material, exposed for the renderer to drive. */
export type CubeBlockUniforms = ReturnType<typeof createCubeBlockUniforms>

export function createCubeBlockUniforms() {
  return {
    // Held as vec3 and converted with int() at use sites: TSL's typed-uniform overloads
    // don't cover ivec3, and section indices are exact in float32 at any renderable range.
    sectionOriginRel: uniform(new THREE.Vector3(0, 0, 0)),
    originDelta: uniform(new THREE.Vector3(0, 0, 0)),
    cameraOriginFrac: uniform(new THREE.Vector3(0, 0, 0)),
    skyLevel: uniform(1),
    debugMode: uniform(0),
    lightCurve: uniform(DEFAULT_LIGHTMAP_PARAMS.curve),
    minBrightness: uniform(DEFAULT_LIGHTMAP_PARAMS.minBrightness),
    lightGamma: uniform(DEFAULT_LIGHTMAP_PARAMS.gamma),
    shadingTheme: uniform(0),
    cardinalLight: uniform(0),
    fogColor: uniform(new THREE.Color(0xff_ff_ff)),
    fogNear: uniform(1),
    fogFar: uniform(1000),
    fogEnabled: uniform(0)
  }
}

/** Indexes a constant table by a dynamic node value without a loop (6 entries). */
function selectVec3(table: readonly (readonly [number, number, number])[], idx: any) {
  let node: any = vec3(...table[table.length - 1])
  for (let i = table.length - 2; i >= 0; i--) {
    node = select(idx.equal(int(i)), vec3(...table[i]), node)
  }
  return node
}

function selectInt(table: readonly number[], idx: any) {
  let node: any = int(table[table.length - 1])
  for (let i = table.length - 2; i >= 0; i--) {
    node = select(idx.equal(int(i)), int(table[i]), node)
  }
  return node
}

/** Mirrors `applyLightmap` in blockEntityLighting.ts / APPLY_LIGHTMAP_GLSL. */
const applyLightmapTsl = (L: any, u: CubeBlockUniforms) => {
  const curved = L.div(float(4).sub(L.mul(3)))
  const shaped = mix(L, curved, u.lightCurve)
  const lifted = mix(u.minBrightness, float(1), shaped)
  return clamp(pow(lifted, u.lightGamma), 0, 1)
}

/** Mirrors `sideShadingFromFaceId`. */
const sideShadingTsl = (faceId: any, theme: any, cardinal: any) => {
  const n = selectVec3(FACE_NORMAL, faceId)
  const hc = float(0.8).add(max(float(0), n.x.mul(0.66).add(n.y.mul(0.66)).add(n.z.mul(0.33))).mul(0.5))
  const nether = float(0.5).add(abs(n.x.mul(0.1).add(n.y.mul(0.4)).add(n.z.mul(0.3))))
  const vanilla = float(0.75)
    .add(n.y.mul(0.25))
    .add(abs(n.z).sub(abs(n.x).mul(3)).mul(0.05))
  return mix(mix(vanilla, nether, cardinal), hc, theme)
}

export type CubeBlockNodeResources = {
  /** Interleaved uvec4 face words, one per face slot. */
  faceWords: THREE.StorageBufferAttribute
  /** Compacted visible face indices written by the culling compute pass. */
  visibleFaces: THREE.StorageBufferAttribute
  atlas: THREE.Texture
  tintPalette: THREE.Texture
}

export function createCubeBlockNodeMaterial(res: CubeBlockNodeResources, u: CubeBlockUniforms = createCubeBlockUniforms()) {
  const material = new THREE.NodeMaterial()
  material.name = 'cubeBlockNodeMaterial'

  const faceWordsBuf = storageTyped(res.faceWords, 'uvec4', res.faceWords.count).toReadOnly()
  const visibleBuf = storageTyped(res.visibleFaces, 'uint', res.visibleFaces.count).toReadOnly()

  // Varyings shared between vertex and fragment stages.
  const vBlockLight = float(0).toVar('vBlockLight').toVarying()
  const vSkyLight = float(0).toVar('vSkyLight').toVarying()
  const vAo = float(0).toVar('vAo').toVarying()
  const vUv = vec2(0).toVar('vUv').toVarying()
  const vFogDepth = float(0).toVar('vFogDepth').toVarying()
  const vTexIndex = int(0).toVar('vTexIndex').toVarying()
  const vTintIndex = int(0).toVar('vTintIndex').toVarying()
  const vFaceId = int(0).toVar('vFaceId').toVarying()

  material.vertexNode = Fn(() => {
    // Indirection: instanceIndex addresses the compacted visible list, not the raw buffer.
    const faceSlot = visibleBuf.element(instanceIndex).toVar()
    const w = faceWordsBuf.element(faceSlot).toVar()
    const w0 = w.x.toVar()
    const w1 = w.y.toVar()
    const w2 = w.z.toVar()
    const w3 = w.w.toVar()

    // 6 non-indexed verts per face instance (2 triangles).
    const viTotal = int(vertexIndex).mod(int(VERTICES_PER_FACE)).toVar()
    const triangle = viTotal.div(int(3)).toVar()
    const corner = viTotal.sub(triangle.mul(int(3))).toVar()

    const faceId = w0.shiftRight(uint(WORD0.FACE_SHIFT)).bitAnd(uint(0x7)).toVar()
    const faceIdI = int(faceId).toVar()
    const diagonalFlag = w2.shiftRight(uint(WORD2.DIAGONAL_FLAG_SHIFT)).bitAnd(uint(0x1)).toVar()

    // SOUTH/NORTH need reversed winding for FrontSide culling: swap corner 1 <-> 2.
    const effCorner = corner.toVar()
    If(faceIdI.equal(int(4)).or(faceIdI.equal(int(5))), () => {
      If(corner.equal(int(1)), () => {
        effCorner.assign(int(2))
      }).ElseIf(corner.equal(int(2)), () => {
        effCorner.assign(int(1))
      })
    })
    const effViTotal = triangle.mul(int(3)).add(effCorner).toVar()
    const vi: any = int(select(diagonalFlag.equal(uint(0)), selectInt(VI_NORMAL, effViTotal), selectInt(VI_FLIPPED, effViTotal))).toVar()

    const u01 = float(vi.bitAnd(int(1))).toVar()
    const v01 = float(vi.shiftRight(int(1)).bitAnd(int(1))).toVar()

    // --- word0: block-local position, tint, AO ---
    const lx = w0.bitAnd(uint(0xf))
    const ly = w0.shiftRight(uint(WORD0.LY_SHIFT)).bitAnd(uint(0xf))
    const lz = w0.shiftRight(uint(WORD0.LZ_SHIFT)).bitAnd(uint(0xf))
    const tint = w0.shiftRight(uint(WORD0.TINT_SHIFT)).bitAnd(uint(0xff))

    const aoShift = uint(WORD0.AO_SHIFT).add(uint(vi).mul(uint(WORD0.AO_BITS_PER_CORNER)))
    const aoLevel = w0.shiftRight(aoShift).bitAnd(uint(0x3))
    vAo.assign(float(aoLevel).add(1).div(4))

    // --- word1: per-corner sky (high nibble) + block (low nibble) light ---
    const lightRaw = w1.shiftRight(uint(vi).mul(uint(WORD1.LIGHT_BITS_PER_CORNER))).bitAnd(uint(0xff))
    vSkyLight.assign(float(lightRaw.shiftRight(uint(4)).bitAnd(uint(0xf))).div(15))
    vBlockLight.assign(float(lightRaw.bitAnd(uint(0xf))).div(15))

    // --- word2: texture index ---
    vTexIndex.assign(int(w2.bitAnd(uint((1 << WORD2.TEX_INDEX_BITS) - 1))))
    vTintIndex.assign(int(tint))
    vFaceId.assign(faceIdI)

    // --- Per-face UV, generated from the same FACE_UV_TERMS as the GLSL path ---
    const uv = faceUvTsl(faceIdI, u01, v01).toVar()
    If(w2.shiftRight(uint(WORD2.FLIP_U_SHIFT)).bitAnd(uint(0x1)).notEqual(uint(0)), () => {
      uv.x.assign(float(1).sub(uv.x))
    })
    If(w0.shiftRight(uint(WORD0.FLIP_V_SHIFT)).bitAnd(uint(0x1)).notEqual(uint(0)), () => {
      uv.y.assign(float(1).sub(uv.y))
    })
    vUv.assign(uv)

    // --- Position: section base (x16) + face quad + block-local, all camera-relative ---
    const sX = int(w3.bitAnd(uint(0xffff)).bitOr(w2.shiftRight(uint(WORD2.SECTION_X_HI_SHIFT)).bitAnd(uint(0x3f)).shiftLeft(uint(16)))).sub(int(WORD3.SECTION_BIAS))
    const sZ = int(
      w3
        .shiftRight(uint(16))
        .bitAnd(uint(0xffff))
        .bitOr(w2.shiftRight(uint(WORD2.SECTION_Z_HI_SHIFT)).bitAnd(uint(0x3f)).shiftLeft(uint(16)))
    ).sub(int(WORD3.SECTION_BIAS))
    const sY = int(w2.shiftRight(uint(WORD2.SECTION_Y_SHIFT)).bitAnd(uint((1 << WORD2.SECTION_Y_BITS) - 1))).sub(int(4))

    const sectionBase = vec3(
      float(sX.sub(int(u.sectionOriginRel.x)).mul(int(16))),
      float(sY.sub(int(u.sectionOriginRel.y)).mul(int(16))),
      float(sZ.sub(int(u.sectionOriginRel.z)).mul(int(16)))
    )

    const facePos = selectVec3(FACE_BASE, faceIdI).add(selectVec3(FACE_DU, faceIdI).mul(u01)).add(selectVec3(FACE_DV, faceIdI).mul(v01))
    const blockLocal = vec3(float(lx), float(ly), float(lz))
    const relativePos = sectionBase.add(u.originDelta).add(facePos).add(blockLocal).sub(u.cameraOriginFrac)

    const mvPosition = modelViewMatrix.mul(vec4(relativePos, 1))
    vFogDepth.assign(mvPosition.z.negate())

    // Empty-slot sentinel: push offscreen rather than discarding, matching the GLSL path.
    const clip = cameraProjectionMatrix.mul(mvPosition).toVar()
    If(w2.shiftRight(uint(WORD2.EMPTY_SHIFT)).bitAnd(uint(0x1)).notEqual(uint(0)), () => {
      clip.assign(vec4(2, 2, 2, 1))
    })
    return clip
  })()

  material.fragmentNode = Fn(() => {
    // Pixelated atlas sample (texelFetch equivalent, no filtering).
    const atlasNode = texture(res.atlas)
    const atlasSize = ivec2n(atlasNode.size(int(0)))
    const tilesPerRow = atlasSize.x.div(int(16)).toVar()
    const tileOrigin = ivec2n(vTexIndex.mod(tilesPerRow), vTexIndex.div(tilesPerRow)).mul(int(16))
    const texel = tileOrigin.add(clamp(ivec2n(vUv.mul(16)), ivec2n(0), ivec2n(15)))
    const baseColor = atlasNode.load(texel).toVar()

    const out = vec4(0, 0, 0, 1).toVar()

    // Debug modes: 4=atlasAlpha, 3=faceId, 2=tileIndex, 1=holes, 0=normal.
    If(u.debugMode.greaterThan(3.5), () => {
      out.assign(vec4(vec3(baseColor.a), 1))
    })
      .ElseIf(u.debugMode.greaterThan(2.5), () => {
        const c = selectVec3(
          [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
            [1, 1, 0],
            [1, 0, 1],
            [0, 1, 1]
          ],
          vFaceId
        )
        out.assign(vec4(c, 1))
      })
      .ElseIf(u.debugMode.greaterThan(1.5), () => {
        const t = float(vTexIndex).div(4095)
        out.assign(vec4(t, fract(float(vTexIndex).div(64)), 0, 1))
      })
      .Else(() => {
        If(baseColor.a.lessThan(0.01), () => {
          If(u.debugMode.greaterThan(0.5), () => {
            out.assign(vec4(1, 0, 0, 1))
          }).Else(() => {
            Discard()
          })
        })

        const tint = texture(res.tintPalette).load(ivec2(vTintIndex, int(0))).rgb
        const L = max(vBlockLight, min(vSkyLight, u.skyLevel))
        const Lm = applyLightmapTsl(L, u)
        const aoFactor = mix(vAo.mul(0.8).add(0.2), vAo, u.shadingTheme)
        const side = sideShadingTsl(vFaceId, u.shadingTheme, u.cardinalLight)
        const brightness = Lm.mul(aoFactor).mul(side)

        // Opaque full cubes are always alpha 1 (legacy uses a cutout material).
        out.assign(vec4(baseColor.rgb.mul(tint).mul(brightness), 1))

        If(u.fogEnabled.greaterThan(0.5), () => {
          const fogFactor = smoothstep(u.fogNear, u.fogFar, vFogDepth)
          out.rgb.assign(mix(out.rgb, u.fogColor, fogFactor))
        })
      })

    return out
  })()

  material.transparent = false
  material.side = THREE.FrontSide
  material.depthWrite = true
  material.depthTest = true

  return { material, uniforms: u }
}
