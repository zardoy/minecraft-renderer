import * as THREE from 'three'
import type { SceneOrigin } from './sceneOrigin'
import { createCanvas } from '../lib/utils'

// Shader code
const vertexShader = `
precision highp float;
attribute vec3 position;
attribute vec4 color;
attribute vec3 velocity;
attribute float adjustSize;
attribute float mass;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float size;

varying vec4 vColor;

void main() {
  vColor = color;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * adjustSize * (300.0 / length(mvPosition.xyz));
  gl_Position = projectionMatrix * mvPosition;
}
`

const fragmentShader = `
precision highp float;
uniform sampler2D texture;
varying vec4 vColor;

void main() {
  vec4 texColor = texture2D(texture, gl_PointCoord);
  gl_FragColor = vColor * texColor;
}
`

// Configuration interfaces
export interface FireworkLaunchOptions {
  /** Position to launch the firework from */
  position?: THREE.Vector3
  /** Particle size (100-600, default: 300) */
  particleSize?: number
  /** Force rich fireworks type (with trails) */
  forceRich?: boolean
  /** Force basic fireworks type (no trails) */
  forceBasic?: boolean
}

export interface FireworksManagerConfig {
  /** Maximum number of active fireworks at once */
  maxActiveFireworks?: number
  /** Default particle size for fireworks */
  defaultParticleSize?: number
}

// Constants
export const FIREWORKS_CONFIG = {
  textureSize: 128,
  gravity: new THREE.Vector3(0, -0.005, 0),
  friction: 0.998,
  defaultParticleSize: 300,
  maxActiveFireworks: 5,
}

// Utility functions
const getOffsetXYZ = (i: number) => {
  const offset = 3
  const index = i * offset
  return { x: index, y: index + 1, z: index + 2 }
}

const getOffsetRGBA = (i: number) => {
  const offset = 4
  const index = i * offset
  return { r: index, g: index + 1, b: index + 2, a: index + 3 }
}

const getRandomNum = (max = 0, min = 0) => Math.floor(Math.random() * (max + 1 - min)) + min

// Texture generation
const drawRadialGradation = (ctx: OffscreenCanvasRenderingContext2D, canvasRadius: number, canvasW: number, canvasH: number) => {
  ctx.save()
  const gradient = ctx.createRadialGradient(canvasRadius, canvasRadius, 0, canvasRadius, canvasRadius, canvasRadius)
  gradient.addColorStop(0, 'rgba(255,255,255,1.0)')
  gradient.addColorStop(0.5, 'rgba(255,255,255,0.5)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, canvasW, canvasH)
  ctx.restore()
}

export const createFireworksTexture = () => {
  const diameter = FIREWORKS_CONFIG.textureSize
  const canvas = createCanvas(diameter, diameter)
  const ctx = canvas.getContext('2d')!
  const canvasRadius = diameter / 2

  drawRadialGradation(ctx, canvasRadius, canvas.width, canvas.height)
  const texture = new THREE.Texture(canvas)
  texture.needsUpdate = true
  return texture
}

// Point mesh creation
const getPointMesh = (num: number, vels: THREE.Vector3[], type: 'seed' | 'trail' | 'default', texture: THREE.Texture, particleSize = FIREWORKS_CONFIG.defaultParticleSize) => {
  const bufferGeometry = new THREE.BufferGeometry()
  const vertices: number[] = []
  const velocities: number[] = []
  const colors: number[] = []
  const adjustSizes: number[] = []
  const masses: number[] = []

  const colorType = Math.random() > 0.3 ? 'single' : 'multiple'
  const singleColor = getRandomNum(100, 20) * 0.01
  const multipleColor = () => getRandomNum(100, 1) * 0.01

  let rgbType: 'red' | 'green' | 'blue' = 'red'
  const rgbTypeDice = Math.random()
  if (rgbTypeDice > 0.66) {
    rgbType = 'red'
  } else if (rgbTypeDice > 0.33) {
    rgbType = 'green'
  } else {
    rgbType = 'blue'
  }

  for (let i = 0; i < num; i++) {
    const pos = new THREE.Vector3(0, 0, 0)
    vertices.push(pos.x, pos.y, pos.z)
    velocities.push(vels[i].x, vels[i].y, vels[i].z)

    if (type === 'seed') {
      let size = vels[i].y ** 2 * 0.04
      if (i === 0) size *= 1.1
      adjustSizes.push(size)
      masses.push(size * 0.017)
      colors.push(1, 1, 1, 1)
    } else if (type === 'trail') {
      const size = Math.random() * 0.1 + 0.1
      adjustSizes.push(size)
      masses.push(size * 0.017)
      colors.push(1, 1, 1, 1)
    } else {
      const size = getRandomNum(particleSize, 10) * 0.001
      adjustSizes.push(size)
      masses.push(size * 0.017)

      if (colorType === 'multiple') {
        colors.push(multipleColor(), multipleColor(), multipleColor(), 1)
      } else {
        switch (rgbType) {
          case 'red':
            colors.push(singleColor, 0.1, 0.1, 1)
            break
          case 'green':
            colors.push(0.1, singleColor, 0.1, 1)
            break
          case 'blue':
            colors.push(0.1, 0.1, singleColor, 1)
            break
        }
      }
    }
  }

  bufferGeometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  bufferGeometry.setAttribute('velocity', new THREE.Float32BufferAttribute(velocities, 3))
  bufferGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4))
  bufferGeometry.setAttribute('adjustSize', new THREE.Float32BufferAttribute(adjustSizes, 1))
  bufferGeometry.setAttribute('mass', new THREE.Float32BufferAttribute(masses, 1))

  const shaderMaterial = new THREE.RawShaderMaterial({
    uniforms: {
      size: { value: FIREWORKS_CONFIG.textureSize },
      texture: { value: texture },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader,
    fragmentShader,
  })

  return new THREE.Points(bufferGeometry, shaderMaterial)
}

// Particle mesh classes
export class ParticleMesh {
  particleNum: number
  timerStartFading: number
  mesh: THREE.Points

  constructor (num: number, vels: THREE.Vector3[], type: 'seed' | 'trail' | 'default', texture: THREE.Texture, particleSize?: number) {
    this.particleNum = num
    this.timerStartFading = 10
    this.mesh = getPointMesh(num, vels, type, texture, particleSize)
  }

  update (gravity: THREE.Vector3) {
    if (this.timerStartFading > 0) this.timerStartFading -= 0.3

    const position = this.mesh.geometry.attributes.position as THREE.BufferAttribute
    const velocity = this.mesh.geometry.attributes.velocity as THREE.BufferAttribute
    const color = this.mesh.geometry.attributes.color as THREE.BufferAttribute
    const mass = this.mesh.geometry.attributes.mass as THREE.BufferAttribute

    const decrementRandom = () => (Math.random() > 0.5 ? 0.98 : 0.96)
    const decrementByVel = (v: number) => (Math.random() > 0.5 ? 0 : (1 - v) * 0.1)

    for (let i = 0; i < this.particleNum; i++) {
      const { x, y, z } = getOffsetXYZ(i)

      velocity.array[y] += gravity.y - mass.array[i]
      velocity.array[x] *= FIREWORKS_CONFIG.friction
      velocity.array[z] *= FIREWORKS_CONFIG.friction
      velocity.array[y] *= FIREWORKS_CONFIG.friction

      position.array[x] += velocity.array[x]
      position.array[y] += velocity.array[y]
      position.array[z] += velocity.array[z]

      const { a } = getOffsetRGBA(i)
      if (this.timerStartFading <= 0) {
        color.array[a] *= decrementRandom() - decrementByVel(color.array[a])
        if (color.array[a] < 0.001) color.array[a] = 0
      }
    }

    position.needsUpdate = true
    velocity.needsUpdate = true
    color.needsUpdate = true
  }

  disposeAll () {
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
  }
}

export class ParticleSeedMesh extends ParticleMesh {
  constructor (num: number, vels: THREE.Vector3[], texture: THREE.Texture) {
    super(num, vels, 'seed', texture)
  }

  update (gravity: THREE.Vector3) {
    const position = this.mesh.geometry.attributes.position as THREE.BufferAttribute
    const velocity = this.mesh.geometry.attributes.velocity as THREE.BufferAttribute
    const color = this.mesh.geometry.attributes.color as THREE.BufferAttribute
    const mass = this.mesh.geometry.attributes.mass as THREE.BufferAttribute

    const decrementRandom = () => (Math.random() > 0.3 ? 0.99 : 0.96)
    const decrementByVel = (v: number) => (Math.random() > 0.3 ? 0 : (1 - v) * 0.1)
    const shake = () => (Math.random() > 0.5 ? 0.05 : -0.05)
    const dice = () => Math.random() > 0.1
    const _f = FIREWORKS_CONFIG.friction * 0.98

    for (let i = 0; i < this.particleNum; i++) {
      const { x, y, z } = getOffsetXYZ(i)

      velocity.array[y] += gravity.y - mass.array[i]
      velocity.array[x] *= _f
      velocity.array[z] *= _f
      velocity.array[y] *= _f

      position.array[x] += velocity.array[x]
      position.array[y] += velocity.array[y]
      position.array[z] += velocity.array[z]

      if (dice()) position.array[x] += shake()
      if (dice()) position.array[z] += shake()

      const { a } = getOffsetRGBA(i)
      color.array[a] *= decrementRandom() - decrementByVel(color.array[a])
      if (color.array[a] < 0.001) color.array[a] = 0
    }

    position.needsUpdate = true
    velocity.needsUpdate = true
    color.needsUpdate = true
  }
}

export class ParticleTailMesh extends ParticleMesh {
  constructor (num: number, vels: THREE.Vector3[], texture: THREE.Texture) {
    super(num, vels, 'trail', texture)
  }

  update (gravity: THREE.Vector3) {
    const position = this.mesh.geometry.attributes.position as THREE.BufferAttribute
    const velocity = this.mesh.geometry.attributes.velocity as THREE.BufferAttribute
    const color = this.mesh.geometry.attributes.color as THREE.BufferAttribute
    const mass = this.mesh.geometry.attributes.mass as THREE.BufferAttribute

    const decrementRandom = () => (Math.random() > 0.3 ? 0.98 : 0.95)
    const shake = () => (Math.random() > 0.5 ? 0.05 : -0.05)
    const dice = () => Math.random() > 0.2

    for (let i = 0; i < this.particleNum; i++) {
      const { x, y, z } = getOffsetXYZ(i)

      velocity.array[y] += gravity.y - mass.array[i]
      velocity.array[x] *= FIREWORKS_CONFIG.friction
      velocity.array[z] *= FIREWORKS_CONFIG.friction
      velocity.array[y] *= FIREWORKS_CONFIG.friction

      position.array[x] += velocity.array[x]
      position.array[y] += velocity.array[y]
      position.array[z] += velocity.array[z]

      if (dice()) position.array[x] += shake()
      if (dice()) position.array[z] += shake()

      const { a } = getOffsetRGBA(i)
      color.array[a] *= decrementRandom()
      if (color.array[a] < 0.001) color.array[a] = 0
    }

    position.needsUpdate = true
    velocity.needsUpdate = true
    color.needsUpdate = true
  }
}

// Fireworks classes
export class BasicFireworks {
  meshGroup: THREE.Group
  isExplode: boolean
  petalsNum: number
  life: number
  seed: ParticleSeedMesh
  flowerSizeRate: number
  flower?: ParticleMesh
  texture: THREE.Texture
  particleSize: number

  constructor (texture: THREE.Texture, particleSize = FIREWORKS_CONFIG.defaultParticleSize, startPosition?: THREE.Vector3) {
    this.meshGroup = new THREE.Group()
    this.isExplode = false
    this.texture = texture
    this.particleSize = particleSize

    const max = 400
    const min = 150
    this.petalsNum = getRandomNum(max, min)
    this.life = 150
    this.seed = this.getSeed(startPosition)
    this.meshGroup.add(this.seed.mesh)
    this.flowerSizeRate = THREE.MathUtils.mapLinear(this.petalsNum, min, max, 0.4, 0.7)
  }

  getSeed (startPosition?: THREE.Vector3): ParticleSeedMesh {
    const num = 40
    const vels: THREE.Vector3[] = []

    for (let i = 0; i < num; i++) {
      const vx = 0
      const vy = i === 0 ? Math.random() * 2.5 + 0.9 : Math.random() * 2 + 0.4
      const vz = 0
      vels.push(new THREE.Vector3(vx, vy, vz))
    }

    const pm = new ParticleSeedMesh(num, vels, this.texture)
    if (startPosition) {
      // World positioning is handled by meshGroup; seed starts at group origin
      pm.mesh.position.set(0, 0, 0)
    } else {
      const x = Math.random() * 80 - 40
      const y = -50
      const z = Math.random() * 80 - 40
      pm.mesh.position.set(x, y, z)
    }

    return pm
  }

  explode (pos: THREE.Vector3) {
    this.isExplode = true
    this.flower = this.getFlower(pos)
    this.meshGroup.add(this.flower.mesh)
    this.meshGroup.remove(this.seed.mesh)
    this.seed.disposeAll()
  }

  getFlower (pos: THREE.Vector3): ParticleMesh {
    const num = this.petalsNum
    const vels: THREE.Vector3[] = []
    let radius: number
    const dice = Math.random()

    if (dice > 0.5) {
      for (let i = 0; i < num; i++) {
        radius = getRandomNum(120, 60) * 0.01
        const theta = THREE.MathUtils.degToRad(Math.random() * 180)
        const phi = THREE.MathUtils.degToRad(Math.random() * 360)
        const vx = Math.sin(theta) * Math.cos(phi) * radius
        const vy = Math.sin(theta) * Math.sin(phi) * radius
        const vz = Math.cos(theta) * radius
        const vel = new THREE.Vector3(vx, vy, vz)
        vel.multiplyScalar(this.flowerSizeRate)
        vels.push(vel)
      }
    } else {
      const zStep = 180 / num
      const trad = (360 * (Math.random() * 20 + 1)) / num
      const xStep = trad
      const yStep = trad
      radius = getRandomNum(120, 60) * 0.01

      for (let i = 0; i < num; i++) {
        const sphereRate = Math.sin(THREE.MathUtils.degToRad(zStep * i))
        const vz = Math.cos(THREE.MathUtils.degToRad(zStep * i)) * radius
        const vx = Math.cos(THREE.MathUtils.degToRad(xStep * i)) * sphereRate * radius
        const vy = Math.sin(THREE.MathUtils.degToRad(yStep * i)) * sphereRate * radius
        const vel = new THREE.Vector3(vx, vy, vz)
        vel.multiplyScalar(this.flowerSizeRate)
        vels.push(vel)
      }
    }

    const particleMesh = new ParticleMesh(num, vels, 'default', this.texture, this.particleSize)
    particleMesh.mesh.position.set(pos.x, pos.y, pos.z)
    return particleMesh
  }

  update (gravity: THREE.Vector3) {
    if (this.isExplode) {
      this.flower!.update(gravity)
      if (this.life > 0) this.life -= 1
    } else {
      this.drawTail()
    }
  }

  drawTail () {
    this.seed.update(FIREWORKS_CONFIG.gravity)

    const position = this.seed.mesh.geometry.attributes.position as THREE.BufferAttribute
    const velocity = this.seed.mesh.geometry.attributes.velocity as THREE.BufferAttribute

    let count = 0

    // Check if the y-axis speed is down for all particles
    for (let i = 0, l = velocity.array.length; i < l; i++) {
      const v = velocity.array[i]
      const index = i % 3
      if (index === 1 && v > 0) {
        count++
      }
    }

    const isComplete = count === 0
    if (!isComplete) return

    const { x, y, z } = this.seed.mesh.position
    const flowerPos = new THREE.Vector3(x, y, z)
    let highestPos = 0
    let offsetPos: THREE.Vector3 | undefined

    for (let i = 0, l = position.array.length; i < l; i++) {
      const p = position.array[i]
      const index = i % 3
      if (index === 1 && p > highestPos) {
        highestPos = p
        offsetPos = new THREE.Vector3(position.array[i - 1], p, position.array[i + 2])
      }
    }

    if (offsetPos) {
      flowerPos.add(offsetPos)
      this.explode(flowerPos)
    }
  }
}

export class RichFireworks extends BasicFireworks {
  tailMeshGroup: THREE.Group
  tails: ParticleTailMesh[]

  constructor (texture: THREE.Texture, particleSize = FIREWORKS_CONFIG.defaultParticleSize, startPosition?: THREE.Vector3) {
    super(texture, particleSize, startPosition)

    const max = 150
    const min = 100
    this.petalsNum = getRandomNum(max, min)
    this.flowerSizeRate = THREE.MathUtils.mapLinear(this.petalsNum, min, max, 0.4, 0.7)
    this.tailMeshGroup = new THREE.Group()
    this.tails = []
  }

  explode (pos: THREE.Vector3) {
    this.isExplode = true
    this.flower = this.getFlower(pos)
    this.tails = this.getTail()
    this.meshGroup.add(this.flower.mesh)
    this.meshGroup.add(this.tailMeshGroup)
  }

  getTail (): ParticleTailMesh[] {
    const tails: ParticleTailMesh[] = []
    const num = 20
    const petalColor = this.flower!.mesh.geometry.attributes.color as THREE.BufferAttribute

    for (let i = 0; i < this.petalsNum; i++) {
      const vels: THREE.Vector3[] = []
      for (let j = 0; j < num; j++) {
        vels.push(new THREE.Vector3(0, 0, 0))
      }

      const tail = new ParticleTailMesh(num, vels, this.texture)
      const { r, g, b, a } = getOffsetRGBA(i)

      const petalR = petalColor.array[r]
      const petalG = petalColor.array[g]
      const petalB = petalColor.array[b]
      const petalA = petalColor.array[a]

      const position = tail.mesh.geometry.attributes.position as THREE.BufferAttribute
      const color = tail.mesh.geometry.attributes.color as THREE.BufferAttribute

      for (let k = 0; k < position.count; k++) {
        const rgba = getOffsetRGBA(k)
        color.array[rgba.r] = petalR
        color.array[rgba.g] = petalG
        color.array[rgba.b] = petalB
        color.array[rgba.a] = petalA
      }

      const { x, y, z } = this.flower!.mesh.position
      tail.mesh.position.set(x, y, z)
      tails.push(tail)
      this.tailMeshGroup.add(tail.mesh)
    }

    return tails
  }

  update (gravity: THREE.Vector3) {
    if (this.isExplode) {
      this.flower!.update(gravity)

      const flowerGeometry = this.flower!.mesh.geometry.attributes.position as THREE.BufferAttribute

      for (let i = 0, l = this.tails.length; i < l; i++) {
        const tail = this.tails[i]
        tail.update(gravity)

        const { x, y, z } = getOffsetXYZ(i)
        const flowerPos = new THREE.Vector3(
          flowerGeometry.array[x],
          flowerGeometry.array[y],
          flowerGeometry.array[z]
        )

        const position = tail.mesh.geometry.attributes.position as THREE.BufferAttribute
        const velocity = tail.mesh.geometry.attributes.velocity as THREE.BufferAttribute

        for (let k = 0; k < position.count; k++) {
          const offset = getOffsetXYZ(k)
          const desiredVelocity = new THREE.Vector3()
          const tailPos = new THREE.Vector3(position.array[offset.x], position.array[offset.y], position.array[offset.z])
          const tailVel = new THREE.Vector3(velocity.array[offset.x], velocity.array[offset.y], velocity.array[offset.z])
          desiredVelocity.subVectors(flowerPos, tailPos)
          const steer = desiredVelocity.sub(tailVel)
          steer.normalize()
          steer.multiplyScalar(Math.random() * 0.0003 * this.life)
          velocity.array[offset.x] += steer.x
          velocity.array[offset.y] += steer.y
          velocity.array[offset.z] += steer.z
        }
        velocity.needsUpdate = true
      }

      if (this.life > 0) this.life -= 1.2
    } else {
      this.drawTail()
    }
  }
}

// Manager class for handling multiple fireworks
export class FireworksManager {
  fireworksInstances: Array<BasicFireworks | RichFireworks>
  scene: THREE.Scene
  sceneOrigin: SceneOrigin
  texture: THREE.Texture
  particleSize: number
  maxFireworks: number

  constructor (scene: THREE.Scene, sceneOrigin: SceneOrigin, config?: FireworksManagerConfig) {
    this.fireworksInstances = []
    this.scene = scene
    this.sceneOrigin = sceneOrigin
    this.texture = createFireworksTexture()
    this.particleSize = config?.defaultParticleSize ?? FIREWORKS_CONFIG.defaultParticleSize
    this.maxFireworks = config?.maxActiveFireworks ?? FIREWORKS_CONFIG.maxActiveFireworks
  }

  launchFirework (options?: FireworkLaunchOptions) {
    if (this.fireworksInstances.length >= this.maxFireworks) return

    const particleSize = options?.particleSize ?? this.particleSize
    const position = options?.position

    let fw: BasicFireworks | RichFireworks
    if (options?.forceRich) {
      fw = new RichFireworks(this.texture, particleSize, position)
    } else if (options?.forceBasic) {
      fw = new BasicFireworks(this.texture, particleSize, position)
    } else {
      fw = Math.random() > 0.5 ? new BasicFireworks(this.texture, particleSize, position) : new RichFireworks(this.texture, particleSize, position)
    }

    // Position the meshGroup in scene-relative coordinates
    if (position) {
      fw.meshGroup.position.set(
        this.sceneOrigin.toSceneX(position.x),
        this.sceneOrigin.toSceneY(position.y),
        this.sceneOrigin.toSceneZ(position.z)
      )
      fw.meshGroup.userData.worldPos = { x: position.x, y: position.y, z: position.z }
    }

    this.fireworksInstances.push(fw)
    this.scene.add(fw.meshGroup)
  }

  repositionAll (): void {
    for (const instance of this.fireworksInstances) {
      if (instance.meshGroup.userData.worldPos) {
        const wp = instance.meshGroup.userData.worldPos
        instance.meshGroup.position.set(
          this.sceneOrigin.toSceneX(wp.x),
          this.sceneOrigin.toSceneY(wp.y),
          this.sceneOrigin.toSceneZ(wp.z)
        )
      }
    }
  }

  update () {
    const explodedIndexList: number[] = []

    for (let i = this.fireworksInstances.length - 1; i >= 0; i--) {
      const instance = this.fireworksInstances[i]
      instance.update(FIREWORKS_CONFIG.gravity)
      if (instance.isExplode) explodedIndexList.push(i)
    }

    for (let i = 0, l = explodedIndexList.length; i < l; i++) {
      const index = explodedIndexList[i]
      const instance = this.fireworksInstances[index]
      if (!instance) continue

      instance.meshGroup.remove(instance.seed.mesh)
      instance.seed.disposeAll()

      if (instance.life <= 0) {
        this.scene.remove(instance.meshGroup)
        if (instance instanceof RichFireworks && instance.tailMeshGroup) {
          for (const v of instance.tails) {
            v.disposeAll()
          }
        }
        instance.flower?.disposeAll()
        this.fireworksInstances.splice(index, 1)
      }
    }
  }

  clear () {
    for (const instance of this.fireworksInstances) {
      this.scene.remove(instance.meshGroup)
      instance.seed.disposeAll()
      if (instance.flower) instance.flower.disposeAll()
      if (instance instanceof RichFireworks) {
        for (const v of instance.tails) v.disposeAll()
      }
    }
    this.fireworksInstances = []
  }

  dispose () {
    this.clear()
    this.texture.dispose()
  }
}
