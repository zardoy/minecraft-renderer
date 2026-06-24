import { PlayerObject, PlayerAnimation } from 'skinview3d'
import * as THREE from 'three'
import { WalkingGeneralSwing } from '../three/entity/animations'
import { loadSkinImage, stevePngUrl } from './utils/skins'

export type PlayerObjectType = PlayerObject & {
  animation?: PlayerAnimation
  realPlayerUuid: string
  realUsername: string
}

const LOG_DEPTH_BIAS = -2e-4 // tune visually; negative ≈ polygonOffset “closer”

function patchLogDepthBiasShader(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.uniforms.uLogDepthBias = { value: LOG_DEPTH_BIAS }
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <logdepthbuf_pars_fragment>',
    `#include <logdepthbuf_pars_fragment>\nuniform float uLogDepthBias;`
  )
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <logdepthbuf_fragment>',
    `#if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
      gl_FragDepth = log2( vFragDepth ) * logDepthBufFC * 0.5 + uLogDepthBias;
    #endif`
  )
}

function applyLogDepthBias(material: THREE.Material): void {
  if (material.userData.logDepthBiasApplied) return
  material.userData.logDepthBiasApplied = true
  material.onBeforeCompile = patchLogDepthBiasShader
  material.needsUpdate = true
}

/** Log-depth world: opaque cutout mats (alphaTest + depthWrite, not transparent sort). */
export function configurePlayerSkinMaterials(playerObject: PlayerObject): void {
  const skin = playerObject.skin as any
  const materials = [skin.layer1Material, skin.layer1MaterialBiased, skin.layer2Material, skin.layer2MaterialBiased]
  for (const mat of materials) {
    mat.transparent = false
    mat.alphaTest = 0.1
    mat.depthWrite = true
  }
  applyLogDepthBias(skin.layer1MaterialBiased)
  applyLogDepthBias(skin.layer2MaterialBiased)
}

export function createPlayerObject(options: { username?: string; uuid?: string; scale?: number }): {
  playerObject: PlayerObjectType
  wrapper: THREE.Group
} {
  const wrapper = new THREE.Group()
  const playerObject = new PlayerObject() as PlayerObjectType

  playerObject.realPlayerUuid = options.uuid ?? ''
  playerObject.realUsername = options.username ?? ''
  playerObject.position.set(0, 16, 0)

  configurePlayerSkinMaterials(playerObject)

  wrapper.add(playerObject as any)
  const scale = options.scale ?? 1 / 16
  wrapper.scale.set(scale, scale, scale)
  wrapper.rotation.set(0, Math.PI, 0)

  // Set up animation
  playerObject.animation = new WalkingGeneralSwing()
  ;(playerObject.animation as WalkingGeneralSwing).isMoving = false
  playerObject.animation.update(playerObject, 0)

  return { playerObject, wrapper }
}

export const applySkinToPlayerObject = async (playerObject: PlayerObjectType, skinUrl: string) => {
  return loadSkinImage(skinUrl || stevePngUrl)
    .then(({ canvas }) => {
      const skinTexture = new THREE.CanvasTexture(canvas)
      skinTexture.magFilter = THREE.NearestFilter
      skinTexture.minFilter = THREE.NearestFilter
      skinTexture.needsUpdate = true
      playerObject.skin.map = skinTexture as any
    })
    .catch(console.error)
}
