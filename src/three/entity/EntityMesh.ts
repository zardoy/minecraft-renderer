import * as THREE from 'three'
import { OBJLoader } from 'three-stdlib'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import huskPng from 'mc-assets/dist/other-textures/latest/entity/zombie/husk.png'
import { Vec3 } from 'vec3'
import ocelotPng from 'mc-assets/dist/other-textures/latest/entity/cat/ocelot.png'
import arrowTexture from 'mc-assets/dist/other-textures/1.21.2/entity/projectiles/arrow.png'
import spectralArrowTexture from 'mc-assets/dist/other-textures/1.21.2/entity/projectiles/spectral_arrow.png'
import tippedArrowTexture from 'mc-assets/dist/other-textures/1.21.2/entity/projectiles/tipped_arrow.png'
import { loadNearestFilterTexture, loadTexture } from '../threeJsUtils'
import { WorldRendererThree } from '../worldRendererThree'
import entities from './entities.json'
import { externalModels } from './objModels'
import externalTexturesJson from './externalTextures.json'
import { createAnimatedObject } from './gltfAnimationUtils'

interface ElemFace {
  dir: [number, number, number]
  u0: [number, number, number]
  v0: [number, number, number]
  u1: [number, number, number]
  v1: [number, number, number]
  corners: Array<[number, number, number, number, number]>
}

interface GeoData {
  positions: number[]
  normals: number[]
  uvs: number[]
  indices: number[]
  skinIndices: number[]
  skinWeights: number[]
}

interface JsonBone {
  name: string
  pivot?: [number, number, number]
  bind_pose_rotation?: [number, number, number]
  rotation?: [number, number, number]
  parent?: string
  cubes?: JsonCube[]
  mirror?: boolean
}

interface JsonCube {
  origin: [number, number, number]
  size: [number, number, number]
  uv: [number, number]
  inflate?: number
  rotation?: [number, number, number]
}

interface JsonModel {
  texturewidth?: number
  textureheight?: number
  bones: JsonBone[]
}

export type CustomModelMetadata = {
  scale?: number
  offset?: { x?: number, y?: number, z?: number }
  texture?: string
  textures?: Record<string, string>
  animation?: string
  animationLoop?: boolean
}

export type CustomModelPart = {
  modelPath: string | ArrayBuffer
  modelType: 'obj' | 'bedrock' | 'gltf'
  metadata?: CustomModelMetadata
}

/** One part, or several (same idea as `models[]` on the custom-model-overlay). */
export type EntityCustomModel = CustomModelPart | { parts: CustomModelPart[] }

interface EntityOverrides {
  textures?: Record<string, string>
  rotation?: Record<string, { x?: number; y?: number; z?: number }>
  customModel?: EntityCustomModel
}

function normalizeCustomModelParts (custom: EntityCustomModel): CustomModelPart[] {
  if ('parts' in custom && Array.isArray(custom.parts)) return custom.parts
  return [custom as CustomModelPart]
}

const elemFaces: Record<string, ElemFace> = {
  up: {
    dir: [0, 1, 0],
    u0: [0, 0, 1],
    v0: [0, 0, 0],
    u1: [1, 0, 1],
    v1: [0, 0, 1],
    corners: [
      [0, 1, 1, 0, 0],
      [1, 1, 1, 1, 0],
      [0, 1, 0, 0, 1],
      [1, 1, 0, 1, 1]
    ]
  },
  down: {
    dir: [0, -1, 0],
    u0: [1, 0, 1],
    v0: [0, 0, 0],
    u1: [2, 0, 1],
    v1: [0, 0, 1],
    corners: [
      [1, 0, 1, 0, 0],
      [0, 0, 1, 1, 0],
      [1, 0, 0, 0, 1],
      [0, 0, 0, 1, 1]
    ]
  },
  east: {
    dir: [1, 0, 0],
    u0: [0, 0, 0],
    v0: [0, 0, 1],
    u1: [0, 0, 1],
    v1: [0, 1, 1],
    corners: [
      [1, 1, 1, 0, 0],
      [1, 0, 1, 0, 1],
      [1, 1, 0, 1, 0],
      [1, 0, 0, 1, 1]
    ]
  },
  west: {
    dir: [-1, 0, 0],
    u0: [1, 0, 1],
    v0: [0, 0, 1],
    u1: [1, 0, 2],
    v1: [0, 1, 1],
    corners: [
      [0, 1, 0, 0, 0],
      [0, 0, 0, 0, 1],
      [0, 1, 1, 1, 0],
      [0, 0, 1, 1, 1]
    ]
  },
  north: {
    dir: [0, 0, -1],
    u0: [0, 0, 1],
    v0: [0, 0, 1],
    u1: [1, 0, 1],
    v1: [0, 1, 1],
    corners: [
      [1, 0, 0, 0, 1],
      [0, 0, 0, 1, 1],
      [1, 1, 0, 0, 0],
      [0, 1, 0, 1, 0]
    ]
  },
  south: {
    dir: [0, 0, 1],
    u0: [1, 0, 2],
    v0: [0, 0, 1],
    u1: [2, 0, 2],
    v1: [0, 1, 1],
    corners: [
      [0, 0, 1, 0, 1],
      [1, 0, 1, 1, 1],
      [0, 1, 1, 0, 0],
      [1, 1, 1, 1, 0]
    ]
  }
}

function dot(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function addCube(
  attr: GeoData,
  boneId: number,
  bone: THREE.Bone,
  cube: JsonCube,
  sameTextureForAllFaces = false,
  texWidth = 64,
  texHeight = 64,
  mirror = false,
  errors: string[] = []
): void {
  const cubeRotation = new THREE.Euler(0, 0, 0)
  if (cube.rotation) {
    cubeRotation.x = -cube.rotation[0] * Math.PI / 180
    cubeRotation.y = -cube.rotation[1] * Math.PI / 180
    cubeRotation.z = -cube.rotation[2] * Math.PI / 180
  }
  for (const { dir, corners, u0, v0, u1, v1 } of Object.values(elemFaces)) {
    const ndx = Math.floor(attr.positions.length / 3)

    const eastOrWest = dir[0] !== 0
    const faceUvs: number[] = []
    for (const pos of corners) {
      let u: number
      let v: number
      if (sameTextureForAllFaces) {
        u = (cube.uv[0] + pos[3] * cube.size[0]) / texWidth
        v = (cube.uv[1] + pos[4] * cube.size[1]) / texHeight
      } else {
        u = (cube.uv[0] + dot(pos[3] ? u1 : u0, cube.size)) / texWidth
        v = (cube.uv[1] + dot(pos[4] ? v1 : v0, cube.size)) / texHeight
      }
      // if (isNaN(u) || isNaN(v)) {
      //   errors.push(`NaN u: ${u}, v: ${v}`)
      //   continue
      // }
      // if (u < 0 || u > 1 || v < 0 || v > 1) {
      //   errors.push(`u: ${u}, v: ${v} out of range`)
      //   continue
      // }

      const posX = eastOrWest && mirror ? pos[0] ^ 1 : pos[0]
      const posY = pos[1]
      const posZ = eastOrWest && mirror ? pos[2] ^ 1 : pos[2]
      const inflate = cube.inflate ?? 0
      let vecPos = new THREE.Vector3(
        cube.origin[0] + posX * cube.size[0] + (posX ? inflate : -inflate),
        cube.origin[1] + posY * cube.size[1] + (posY ? inflate : -inflate),
        cube.origin[2] + posZ * cube.size[2] + (posZ ? inflate : -inflate)
      )

      vecPos = vecPos.applyEuler(cubeRotation)
      vecPos = vecPos.sub(bone.position)
      vecPos = vecPos.applyEuler(bone.rotation)
      vecPos = vecPos.add(bone.position)

      attr.positions.push(vecPos.x, vecPos.y, vecPos.z)
      attr.normals.push(dir[0], dir[1], dir[2])
      faceUvs.push(u, v)
      attr.skinIndices.push(boneId, 0, 0, 0)
      attr.skinWeights.push(1, 0, 0, 0)
    }

    if (mirror) {
      for (let i = 0; i + 1 < corners.length; i += 2) {
        const faceIndex = i * 2
        const tempFaceUvs = faceUvs.slice(faceIndex, faceIndex + 4)
        faceUvs[faceIndex] = tempFaceUvs[2]
        faceUvs[faceIndex + 1] = tempFaceUvs[eastOrWest ? 1 : 3]
        faceUvs[faceIndex + 2] = tempFaceUvs[0]
        faceUvs[faceIndex + 3] = tempFaceUvs[eastOrWest ? 3 : 1]
      }
    }
    attr.uvs.push(...faceUvs)

    attr.indices.push(ndx, ndx + 1, ndx + 2, ndx + 2, ndx + 1, ndx + 3)
  }
}

export function getMesh(
  worldRenderer: WorldRendererThree | undefined,
  texture: string,
  jsonModel: JsonModel,
  overrides: EntityOverrides = {},
  debugFlags: EntityDebugFlags = {}
): THREE.SkinnedMesh {
  let textureWidth = jsonModel.texturewidth ?? 64
  let textureHeight = jsonModel.textureheight ?? 64
  let textureOffset: number[] | undefined
  const useBlockTexture = texture.startsWith('block:')
  const blocksTexture = worldRenderer?.material.map as THREE.Texture<HTMLImageElement | ImageBitmap> | null | undefined
  if (useBlockTexture) {
    if (!worldRenderer) throw new Error('worldRenderer is required for block textures')
    const blockName = texture.slice(6)
    const textureInfo = worldRenderer.resourcesManager.currentResources.blocksAtlasJson.textures[blockName]
    if (textureInfo) {
      textureWidth = blocksTexture?.image.width ?? textureWidth
      textureHeight = blocksTexture?.image.height ?? textureHeight
      // todo support su/sv
      textureOffset = [textureInfo.u, textureInfo.v]
    } else {
      console.error(`Unknown block ${blockName}`)
    }
  }

  const bones: Record<string, THREE.Bone> = {}

  const geoData: GeoData = {
    positions: [],
    normals: [],
    uvs: [],
    indices: [],
    skinIndices: [],
    skinWeights: []
  }
  let i = 0
  for (const jsonBone of jsonModel.bones) {
    const bone = new THREE.Bone()
    if (jsonBone.pivot) {
      bone.position.x = jsonBone.pivot[0]
      bone.position.y = jsonBone.pivot[1]
      bone.position.z = jsonBone.pivot[2]
    }
    if (jsonBone.bind_pose_rotation) {
      bone.rotation.x = -jsonBone.bind_pose_rotation[0] * Math.PI / 180
      bone.rotation.y = -jsonBone.bind_pose_rotation[1] * Math.PI / 180
      bone.rotation.z = -jsonBone.bind_pose_rotation[2] * Math.PI / 180
    } else if (jsonBone.rotation) {
      bone.rotation.x = -jsonBone.rotation[0] * Math.PI / 180
      bone.rotation.y = -jsonBone.rotation[1] * Math.PI / 180
      bone.rotation.z = -jsonBone.rotation[2] * Math.PI / 180
    }
    if (overrides.rotation?.[jsonBone.name]) {
      bone.rotation.x -= (overrides.rotation[jsonBone.name].x ?? 0) * Math.PI / 180
      bone.rotation.y -= (overrides.rotation[jsonBone.name].y ?? 0) * Math.PI / 180
      bone.rotation.z -= (overrides.rotation[jsonBone.name].z ?? 0) * Math.PI / 180
    }
    bone.name = `bone_${jsonBone.name}`
    bones[jsonBone.name] = bone

    if (jsonBone.cubes) {
      for (const cube of jsonBone.cubes) {
        const errors: string[] = []
        addCube(geoData, i, bone, cube, useBlockTexture, textureWidth, textureHeight, jsonBone.mirror, errors)
        if (errors.length) {
          debugFlags.errors ??= []
          debugFlags.errors.push(...errors.map(error => `Bone ${jsonBone.name}: ${error}`))
        }
      }
    }
    i++
  }

  const rootBones: THREE.Object3D[] = []
  for (const jsonBone of jsonModel.bones) {
    if (jsonBone.parent && bones[jsonBone.parent]) {
      bones[jsonBone.parent].add(bones[jsonBone.name])
    } else {
      rootBones.push(bones[jsonBone.name])
    }
  }

  const skeleton = new THREE.Skeleton(Object.values(bones))

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(geoData.positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(geoData.normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(geoData.uvs, 2))
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(geoData.skinIndices, 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(geoData.skinWeights, 4))
  geometry.setIndex(geoData.indices)

  const material = new THREE.MeshLambertMaterial({ transparent: true, alphaTest: 0.1, side: THREE.DoubleSide })
  const mesh = new THREE.SkinnedMesh(geometry, material)
  mesh.add(...rootBones)
  mesh.bind(skeleton)
  mesh.scale.set(1 / 16, 1 / 16, 1 / 16)

  if (textureOffset) {
    // todo(memory) dont clone
    const loadedTexture = blocksTexture!.clone()
    loadedTexture.offset.set(textureOffset[0], textureOffset[1])
    loadedTexture.needsUpdate = true
    material.map = loadedTexture
  } else {
    void loadTexture(texture, loadedTexture => {
      if (material.map) {
        // texture is already loaded
        return
      }
      loadedTexture.magFilter = THREE.NearestFilter
      loadedTexture.minFilter = THREE.NearestFilter
      loadedTexture.flipY = false
      loadedTexture.wrapS = THREE.RepeatWrapping
      loadedTexture.wrapT = THREE.RepeatWrapping
      material.map = loadedTexture
    }, () => {
      // This callback runs after the texture is fully loaded
      const map = material.map as THREE.Texture<HTMLImageElement | ImageBitmap> | null
      if (!map) return
      const actualWidth = map.image.width
      if (actualWidth && textureWidth !== actualWidth) {
        map.repeat.x = textureWidth / actualWidth
      }
      const actualHeight = map.image.height
      if (actualHeight && textureHeight !== actualHeight) {
        map.repeat.y = textureHeight / actualHeight
      }
      material.needsUpdate = true
    })
  }

  return mesh
}

export const rendererSpecialHandled = ['item_frame', 'item', 'player']

type EntityMapping = {
  pattern: string | RegExp
  target: string
}

const temporaryMappings: EntityMapping[] = [
  // Exact matches
  { pattern: 'furnace_minecart', target: 'minecart' },
  { pattern: 'spawner_minecart', target: 'minecart' },
  { pattern: 'chest_minecart', target: 'minecart' },
  { pattern: 'hopper_minecart', target: 'minecart' },
  { pattern: 'command_block_minecart', target: 'minecart' },
  { pattern: 'tnt_minecart', target: 'minecart' },
  { pattern: 'glow_item_frame', target: 'item_frame' },
  { pattern: 'glow_squid', target: 'squid' },
  { pattern: 'trader_llama', target: 'llama' },
  { pattern: 'chest_boat', target: 'boat' },
  { pattern: 'spectral_arrow', target: 'arrow' },
  { pattern: 'husk', target: 'zombie' },
  { pattern: 'zombie_horse', target: 'horse' },
  { pattern: 'donkey', target: 'horse' },
  { pattern: 'skeleton_horse', target: 'horse' },
  { pattern: 'mule', target: 'horse' },
  { pattern: 'ocelot', target: 'cat' },
  // Regex patterns
  { pattern: /_minecraft$/, target: 'minecraft' },
  { pattern: /_boat$/, target: 'boat' },
  { pattern: /_raft$/, target: 'boat' },
  { pattern: /_horse$/, target: 'horse' },
  { pattern: /_zombie$/, target: 'zombie' },
  { pattern: /_arrow$/, target: 'zombie' },
]

function getEntityMapping(type: string): string | undefined {
  for (const mapping of temporaryMappings) {
    if (typeof mapping.pattern === 'string') {
      if (mapping.pattern === type) return mapping.target
    } else if (mapping.pattern.test(type)) { return mapping.target }
  }
  return undefined
}

const getEntity = (name: string) => {
  return entities[name]
}

const scaleEntity: Record<string, number> = {
  zombie: 1.85,
  husk: 1.85,
  arrow: 0.0025
}

const offsetEntity: Record<string, Vec3> = {
  zombie: new Vec3(0, 1, 0),
  husk: new Vec3(0, 1, 0),
  boat: new Vec3(0, -1, 0),
  arrow: new Vec3(0, -0.9, 0)
}

interface EntityGeometry {
  geometry: Array<{
    name: string;
    [key: string]: any;
  }>;
}

export type EntityModelType = 'obj' | 'bedrock' | 'gltf'

export type EntityDebugFlags = {
  type?: 'obj' | 'bedrock' | 'gltf' | 'special'
  tempMap?: string
  textureMap?: boolean
  errors?: string[]
  isHardcodedTexture?: boolean
}

export class EntityMesh {
  mesh!: THREE.Object3D
  animations?: THREE.AnimationClip[]
  private animationControllers: Array<ReturnType<typeof createAnimatedObject>> = []

  constructor(
    version: string,
    type: string,
    worldRenderer?: WorldRendererThree,
    overrides: EntityOverrides = {},
    debugFlags: EntityDebugFlags = {}
  ) {
    const originalType = type
    const mappedValue = getEntityMapping(type)
    if (mappedValue) {
      type = mappedValue
      debugFlags.tempMap = mappedValue
    }

    // Handle custom model override (single or multiple parts)
    if (overrides.customModel) {
      const parts = normalizeCustomModelParts(overrides.customModel)
      this.mesh = new THREE.Object3D()

      for (let i = 0; i < parts.length; i++) {
        const { modelPath, modelType, metadata } = parts[i]
        const partRoot = new THREE.Object3D()
        partRoot.name = `custom_part_${i}`

        switch (modelType) {
          case 'gltf': {
            const loader = new GLTFLoader()
            void loader.parseAsync(modelPath, '').then(gltf => {
              partRoot.add(gltf.scene)
              if (metadata?.scale) {
                const s = metadata.scale
                partRoot.scale.set(s, s, s)
              }
              if (metadata?.offset) {
                const { x = 0, y = 0, z = 0 } = metadata.offset
                partRoot.position.set(x, y, z)
              }
              if (metadata?.texture) {
                const texture = loadNearestFilterTexture(metadata.texture)
                partRoot.traverse((child) => {
                  if (child instanceof THREE.Mesh) {
                    child.material = new THREE.MeshBasicMaterial({
                      map: texture,
                      transparent: true,
                      alphaTest: 0.1
                    })
                  }
                })
              }
              if (gltf.animations?.length) {
                this.animations = [...(this.animations ?? []), ...gltf.animations]
                const controller = createAnimatedObject(partRoot, gltf.animations)
                this.animationControllers.push(controller)
                const animationName = metadata?.animation
                const loop = metadata?.animationLoop ?? true
                if (animationName) {
                  controller.playAnimation(animationName, loop)
                } else {
                  controller.playAnimation(gltf.animations[0].name, loop)
                }
              }
            }).catch(err => {
              console.error('Failed to load GLTF model:', err)
            })
            break
          }
          case 'obj': {
            const objLoader = new OBJLoader()
            const obj = objLoader.parse(modelPath as string)
            if (metadata?.scale) {
              const { scale } = metadata
              obj.scale.set(scale, scale, scale)
            }
            if (metadata?.offset) {
              const { x = 0, y = 0, z = 0 } = metadata.offset
              obj.position.set(x, y, z)
            }
            if (metadata?.texture) {
              const texture = loadNearestFilterTexture(metadata.texture)
              const material = new THREE.MeshBasicMaterial({
                map: texture,
                transparent: true,
                alphaTest: 0.1
              })
              obj.traverse((child) => {
                if (child instanceof THREE.Mesh) {
                  child.material = material
                }
              })
            }
            partRoot.add(obj)
            break
          }
          case 'bedrock': {
            const modelData = JSON.parse(modelPath as string)
            if (metadata?.scale) {
              partRoot.scale.set(metadata.scale, metadata.scale, metadata.scale)
            }
            if (metadata?.offset) {
              const { x = 0, y = 0, z = 0 } = metadata.offset
              partRoot.position.set(x, y, z)
            }
            for (const [name, jsonModel] of Object.entries(modelData.geometry)) {
              const texture = metadata?.textures?.[name] ?? modelData.textures?.[name]
              if (!texture) continue
              const mesh = getMesh(worldRenderer,
                texture.endsWith('.png') || texture.startsWith('data:image/') || texture.startsWith('block:')
                  ? texture : texture + '.png',
                jsonModel as JsonModel,
                overrides,
                debugFlags)
              mesh.name = `geometry_${name}`
              partRoot.add(mesh)
            }
            break
          }
        }
        this.mesh.add(partRoot)
      }
      debugFlags.type = parts.length === 1 ? parts[0].modelType : 'special'
      return
    }

    if (externalModels[type]) {
      const objLoader = new OBJLoader()
      const texturePathMap = {
        'zombie_horse': `textures/${version}/entity/horse/horse_zombie.png`,
        'husk': huskPng,
        'skeleton_horse': `textures/${version}/entity/horse/horse_skeleton.png`,
        'donkey': `textures/${version}/entity/horse/donkey.png`,
        'mule': `textures/${version}/entity/horse/mule.png`,
        'ocelot': ocelotPng,
        'arrow': arrowTexture,
        'spectral_arrow': spectralArrowTexture,
        'tipped_arrow': tippedArrowTexture
      }
      const tempTextureMap = texturePathMap[originalType] || texturePathMap[type]
      if (tempTextureMap) {
        debugFlags.textureMap = true
      }
      const texturePath = tempTextureMap || externalTexturesJson[type]
      if (externalTexturesJson[type]) {
        debugFlags.isHardcodedTexture = true
      }
      if (!texturePath) throw new Error(`No texture for ${type}`)
      const texture = loadNearestFilterTexture(texturePath)
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        alphaTest: 0.1
      })
      const obj = objLoader.parse(externalModels[type])
      const scale = scaleEntity[originalType] || scaleEntity[type]
      if (scale) obj.scale.set(scale, scale, scale)
      const offset = offsetEntity[originalType]
      if (offset) obj.position.set(offset.x, offset.y, offset.z)
      obj.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.material = material
          // todo
          if (child.name === 'Head layer') child.visible = false
          if (child.name === 'Head' && overrides.rotation?.head) { // todo
            child.rotation.x -= (overrides.rotation.head.x ?? 0) * Math.PI / 180
            child.rotation.y -= (overrides.rotation.head.y ?? 0) * Math.PI / 180
            child.rotation.z -= (overrides.rotation.head.z ?? 0) * Math.PI / 180
          }
        }
      })
      this.mesh = obj
      debugFlags.type = 'obj'
      return
    }

    if (originalType === 'arrow') {
      // overrides.textures = {
      //   'default': testArrow,
      //   ...overrides.textures,
      // }
    }

    const e = getEntity(type)
    if (!e) {
      // if (knownNotHandled.includes(type)) return
      // throw new Error(`Unknown entity ${type}`)
      return
    }

    this.mesh = new THREE.Object3D()
    for (const [name, jsonModel] of Object.entries(e.geometry)) {
      const texture = overrides.textures?.[name] ?? e.textures[name]
      if (!texture) continue
      // console.log(JSON.stringify(jsonModel, null, 2))
      const mesh = getMesh(worldRenderer,
        texture.endsWith('.png') || texture.startsWith('data:image/') || texture.startsWith('block:')
          ? texture : texture + '.png',
        jsonModel,
        overrides,
        debugFlags)
      mesh.name = `geometry_${name}`
      this.mesh.add(mesh)
    }
    debugFlags.type = 'bedrock'
  }

  playAnimation(name: string, loop = false) {
    if (!this.animationControllers.length) {
      console.warn('No animation controller available')
      return
    }
    let ok = false
    for (const c of this.animationControllers) {
      if (c.playAnimation(name, loop)) ok = true
    }
    if (!ok) {
      console.warn(`Animation "${name}" not found on any custom model part`)
    }
  }

  update(deltaTime: number) {
    // Animation updates are now handled by onBeforeRender callback
    // This method is kept for compatibility but no longer needed
  }

  static getStaticData(name: string): { boneNames: string[] } {
    name = getEntityMapping(name) || name
    if (externalModels[name]) {
      return {
        boneNames: [] // todo
      }
    }
    const e = getEntity(name) as EntityGeometry
    if (!e) throw new Error(`Unknown entity ${name}`)
    return {
      boneNames: Object.values(e.geometry).flatMap(x => x.name)
    }
  }
}
globalThis.EntityMesh = EntityMesh
