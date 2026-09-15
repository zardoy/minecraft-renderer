/**
 * TSL shader for non-full-block geometry (stairs, slabs, fences, models).
 *
 * Pure **vertex pulling**: the geometry carries no attributes at all. Each instance is one
 * quad; `vertexIndex % 6` selects a corner from the quad's packed 2-bit template, and the
 * vertex data is read from storage buffers. That means:
 *
 *   - no index buffer, and no per-instance vertex attribute bindings
 *   - the same compacted-visible-list indirection as the cube path, so `cullCompute` is
 *     reused unchanged
 *   - the whole non-cube world is one additional `drawIndirect`
 *
 * Lighting deliberately mirrors the cube shader (`max(block, min(sky, skyLevel))` fed
 * through the shared lightmap curve) so the two passes agree where they meet — a mismatch
 * there is very visible along stair/slab edges against neighbouring full blocks.
 */

import * as THREE from 'three/webgpu'
import { Fn, If, vec2, vec3, vec4, int, uint, float, uniform, texture, instanceIndex, vertexIndex, cameraProjectionMatrix, modelViewMatrix, mix, max, min, clamp, pow, smoothstep, Discard } from 'three/tsl'

import { storageTyped, ivec2n } from './tslCompat'
import { SECTION_INDEX_SHIFT, DRAW_VERTS_PER_QUAD } from '../globalLegacyBufferGPU'
import { SECTION_META_STRIDE } from '../globalBlockBufferGPU'
import { DEFAULT_LIGHTMAP_PARAMS } from '../../lib/blockEntityLighting'

export type LegacyBlockUniforms = ReturnType<typeof createLegacyBlockUniforms>

export function createLegacyBlockUniforms() {
  return {
    sectionOriginRel: uniform(new THREE.Vector3(0, 0, 0)),
    originDelta: uniform(new THREE.Vector3(0, 0, 0)),
    cameraOriginFrac: uniform(new THREE.Vector3(0, 0, 0)),
    skyLevel: uniform(1),
    lightCurve: uniform(DEFAULT_LIGHTMAP_PARAMS.curve),
    minBrightness: uniform(DEFAULT_LIGHTMAP_PARAMS.minBrightness),
    lightGamma: uniform(DEFAULT_LIGHTMAP_PARAMS.gamma),
    /** Cutout threshold; legacy models rely on alpha-tested foliage/panes. */
    alphaTest: uniform(0.1),
    fogColor: uniform(new THREE.Color(0xff_ff_ff)),
    fogNear: uniform(1),
    fogFar: uniform(1000),
    fogEnabled: uniform(0)
  }
}

export type LegacyBlockNodeResources = {
  positions: THREE.StorageBufferAttribute
  uvs: THREE.StorageBufferAttribute
  colors: THREE.StorageBufferAttribute
  skyLights: THREE.StorageBufferAttribute
  blockLights: THREE.StorageBufferAttribute
  quadMeta: THREE.StorageBufferAttribute
  sectionMeta: THREE.StorageBufferAttribute
  visibleQuads: THREE.StorageBufferAttribute
  atlas: THREE.Texture
}

export type LegacyBlockMaterialOptions = {
  /**
   * Blended (water, glass, ice) rather than alpha-tested. Switches to alpha blending with
   * depth writes off, and drops the cutout discard.
   */
  transparent?: boolean
}

export function createLegacyBlockNodeMaterial(
  res: LegacyBlockNodeResources,
  u: LegacyBlockUniforms = createLegacyBlockUniforms(),
  opts: LegacyBlockMaterialOptions = {}
) {
  const material = new THREE.NodeMaterial()
  material.name = opts.transparent ? 'blendBlockNodeMaterial' : 'legacyBlockNodeMaterial'

  const positionsBuf = storageTyped(res.positions, 'vec3', res.positions.count).toReadOnly()
  const uvsBuf = storageTyped(res.uvs, 'vec2', res.uvs.count).toReadOnly()
  const colorsBuf = storageTyped(res.colors, 'vec3', res.colors.count).toReadOnly()
  const skyBuf = storageTyped(res.skyLights, 'float', res.skyLights.count).toReadOnly()
  const blockBuf = storageTyped(res.blockLights, 'float', res.blockLights.count).toReadOnly()
  const quadMetaBuf = storageTyped(res.quadMeta, 'uint', res.quadMeta.count * 2).toReadOnly()
  const sectionMetaBuf = storageTyped(res.sectionMeta, 'int', res.sectionMeta.count * SECTION_META_STRIDE).toReadOnly()
  const visibleBuf = storageTyped(res.visibleQuads, 'uint', res.visibleQuads.count).toReadOnly()

  const vUv = vec2(0).toVar('vUvLegacy').toVarying()
  const vColor = vec3(1).toVar('vColorLegacy').toVarying()
  const vSky = float(0).toVar('vSkyLegacy').toVarying()
  const vBlock = float(0).toVar('vBlockLegacy').toVarying()
  const vFogDepth = float(0).toVar('vFogDepthLegacy').toVarying()

  material.vertexNode = Fn(() => {
    const quad = visibleBuf.element(instanceIndex).toVar()
    const metaBase = quad.mul(uint(2)).toVar()
    const vertBase = quadMetaBuf.element(metaBase).toVar()
    const packed = quadMetaBuf.element(metaBase.add(uint(1))).toVar()

    // Corner template: 2 bits per draw vertex, 6 entries.
    const slot = uint(int(vertexIndex).mod(int(DRAW_VERTS_PER_QUAD))).toVar()
    const corner = packed.shiftRight(slot.mul(uint(2))).bitAnd(uint(0x3)).toVar()
    const vertexId = vertBase.add(corner).toVar()

    const sectionIndex = packed.shiftRight(uint(SECTION_INDEX_SHIFT)).bitAnd(uint(0xf_ff_ff)).toVar()
    const sBase = int(sectionIndex).mul(int(SECTION_META_STRIDE)).toVar()
    const sx = sectionMetaBuf.element(sBase).toVar()
    const sy = sectionMetaBuf.element(sBase.add(int(1))).toVar()
    const sz = sectionMetaBuf.element(sBase.add(int(2))).toVar()

    vUv.assign(uvsBuf.element(vertexId))
    vColor.assign(colorsBuf.element(vertexId))
    vSky.assign(skyBuf.element(vertexId))
    vBlock.assign(blockBuf.element(vertexId))

    // Same camera-relative construction as the cube shader: integer section origin kept
    // apart from the fractional remainder so float32 never holds a raw world coordinate.
    const sectionBase = vec3(
      float(sx.sub(int(u.sectionOriginRel.x)).mul(int(16))),
      float(sy.sub(int(u.sectionOriginRel.y)).mul(int(16))),
      float(sz.sub(int(u.sectionOriginRel.z)).mul(int(16)))
    )
    const local = positionsBuf.element(vertexId)
    const relativePos = sectionBase.add(u.originDelta).add(local).sub(u.cameraOriginFrac)

    const mvPosition = modelViewMatrix.mul(vec4(relativePos, 1))
    vFogDepth.assign(mvPosition.z.negate())
    return cameraProjectionMatrix.mul(mvPosition)
  })()

  material.fragmentNode = Fn(() => {
    const atlasNode = texture(res.atlas)
    const baseColor = atlasNode.sample(vUv).toVar()

    if (opts.transparent) {
      // Fully transparent texels still cost a blend; drop them.
      If(baseColor.a.lessThan(float(0.01)), () => {
        Discard()
      })
    } else {
      // Cutout: foliage, panes, torches all depend on this.
      If(baseColor.a.lessThan(u.alphaTest), () => {
        Discard()
      })
    }

    const L = max(vBlock, min(vSky, u.skyLevel))
    const curved = L.div(float(4).sub(L.mul(3)))
    const shaped = mix(L, curved, u.lightCurve)
    const lifted = mix(u.minBrightness, float(1), shaped)
    const brightness = clamp(pow(lifted, u.lightGamma), 0, 1)

    const out = vec4(baseColor.rgb.mul(vColor).mul(brightness), baseColor.a).toVar()

    If(u.fogEnabled.greaterThan(0.5), () => {
      const fogFactor = smoothstep(u.fogNear, u.fogFar, vFogDepth)
      out.rgb.assign(mix(out.rgb, u.fogColor, fogFactor))
    })

    return out
  })()

  material.side = THREE.DoubleSide // models have inward-facing geometry (e.g. panes, plants)
  material.depthTest = true

  if (opts.transparent) {
    material.transparent = true
    material.blending = THREE.NormalBlending
    // Depth writes off so transparent surfaces don't occlude each other.
    material.depthWrite = false
  } else {
    material.transparent = false
    material.depthWrite = true
  }

  return { material, uniforms: u }
}
