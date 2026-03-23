import * as THREE from 'three'
import * as tweenJs from '@tweenjs/tween.js'
import PrismarineItem from 'prismarine-item'
import { WorldBlockProvider } from 'mc-assets/dist/worldBlockProvider'
import { BlockModel } from 'mc-assets'
import { DebugGui } from '../lib/DebugGui'
import { SmoothSwitcher } from '../lib/smoothSwitcher'
import { watchProperty } from '../lib/utils/proxy'
import { getMyHand } from './hand'
import { WorldRendererThree } from './worldRendererThree'
import { disposeObject } from './threeJsUtils'
import { HandItemBlock, MovementState } from '../playerState/types'
import { PlayerStateRenderer } from '../playerState/playerState'
import { getThreeBlockModelGroup } from '../mesher/standaloneRenderer'
import { IndexedData } from 'minecraft-data'
import { WorldRendererConfig } from '../graphicsBackend'

const _tempMat = new THREE.Matrix4()

// Vanilla renderPlayerArm transform chain
function buildBareHandMatrix(swingProgress: number, equipProgress: number): THREE.Matrix4 {
  const mat = new THREE.Matrix4()
  const side = 1 // right hand

  const sqrtSwing = Math.sqrt(swingProgress)
  const swingX = -0.3 * Math.sin(sqrtSwing * Math.PI)
  const swingY = 0.4 * Math.sin(sqrtSwing * 2 * Math.PI)
  const swingZ = -0.4 * Math.sin(swingProgress * Math.PI)

  // Step 1: Base position with swing
  mat.multiply(_tempMat.makeTranslation(side * (swingX + 0.64), swingY - 0.6 + equipProgress * -0.6, swingZ - 0.72))
  // Step 2: Base Y rotation 45°
  mat.multiply(_tempMat.makeRotationY(side * 45 * Math.PI / 180))
  // Step 3: Swing Y rotation
  mat.multiply(_tempMat.makeRotationY(side * Math.sin(sqrtSwing * Math.PI) * 70 * Math.PI / 180))
  // Step 4: Swing Z rotation
  mat.multiply(_tempMat.makeRotationZ(side * Math.sin(swingProgress * swingProgress * Math.PI) * -20 * Math.PI / 180))
  // Step 5: Second translation
  mat.multiply(_tempMat.makeTranslation(side * -1, 3.6, 3.5))
  // Step 6: Z rotation 120°
  mat.multiply(_tempMat.makeRotationZ(side * 120 * Math.PI / 180))
  // Step 7: X rotation 200°
  mat.multiply(_tempMat.makeRotationX(200 * Math.PI / 180))
  // Step 8: Y rotation -135°
  mat.multiply(_tempMat.makeRotationY(side * -135 * Math.PI / 180))
  // Step 9: Final X offset
  mat.multiply(_tempMat.makeTranslation(side * 5.6, 0, 0))
  // Step 10: translateToHand - arm part position (-5/16, 2/16, 0)
  mat.multiply(_tempMat.makeTranslation(side * -5 / 16, 2 / 16, 0))

  return mat
}

// Vanilla item arm transforms: applyItemArmTransform + applyItemArmAttackTransform
function buildItemArmMatrix(swingProgress: number, equipProgress: number): THREE.Matrix4 {
  const mat = new THREE.Matrix4()
  const side = 1 // right hand

  const sqrtSwing = Math.sqrt(swingProgress)

  // Swing position offsets (from renderArmWithItem default branch)
  const swingX = -0.4 * Math.sin(sqrtSwing * Math.PI)
  const swingY = 0.2 * Math.sin(sqrtSwing * 2 * Math.PI)
  const swingZ = -0.2 * Math.sin(swingProgress * Math.PI)
  mat.multiply(_tempMat.makeTranslation(side * swingX, swingY, swingZ))

  // applyItemArmTransform: translate(±0.56, -0.52 + equip*-0.6, -0.72)
  mat.multiply(_tempMat.makeTranslation(side * 0.56, -0.52 + equipProgress * -0.6, -0.72))

  // applyItemArmAttackTransform
  const sinSwingSq = Math.sin(swingProgress * swingProgress * Math.PI)
  const sinSqrtSwing = Math.sin(sqrtSwing * Math.PI)
  mat.multiply(_tempMat.makeRotationY(side * (45 + sinSwingSq * -20) * Math.PI / 180))
  mat.multiply(_tempMat.makeRotationZ(side * sinSqrtSwing * -20 * Math.PI / 180))
  mat.multiply(_tempMat.makeRotationX(sinSqrtSwing * -80 * Math.PI / 180))
  mat.multiply(_tempMat.makeRotationY(side * -45 * Math.PI / 180))

  return mat
}

export default class HoldingBlock {
  // TODO refactor with the tree builder for better visual understanding
  holdingBlock: THREE.Object3D | undefined = undefined
  blockSwapAnimation: {
    switcher: SmoothSwitcher
    // hidden: boolean
  } | undefined = undefined
  cameraGroup = new THREE.Mesh()
  armTransformGroup = new THREE.Group()
  camera = new THREE.PerspectiveCamera(70, 1, 0.05, 100)
  equipProgress = 0 // 0 = fully visible, 1 = hidden
  stopUpdate = false
  lastHeldItem: HandItemBlock | undefined
  isSwinging = false
  nextIterStopCallbacks: Array<() => void> | undefined
  idleAnimator: HandIdleAnimator | undefined
  ready = false
  lastUpdate = 0
  playerHand: THREE.Object3D | undefined
  offHandDisplay = false
  offHandModeLegacy = false

  swingAnimator: HandSwingAnimator | undefined
  config: WorldRendererConfig

  constructor(public worldRenderer: WorldRendererThree, public offHand = false) {
    this.initCameraGroup()
    this.worldRenderer.onReactivePlayerStateUpdated('heldItemMain', () => {
      if (!this.offHand) {
        this.updateItem()
      }
    }, false)
    this.worldRenderer.onReactivePlayerStateUpdated('heldItemOff', () => {
      if (this.offHand) {
        this.updateItem()
      }
    }, false)
    this.config = worldRenderer.displayOptions.inWorldRenderingConfig

    this.offHandDisplay = this.offHand
    // this.offHandDisplay = true
    if (!this.offHand) {
      // load default hand
      void getMyHand().then((hand) => {
        this.playerHand = hand
        // trigger update
        this.updateItem()
      }).then(() => {
        // now watch over the player skin
        watchProperty(
          async () => {
            return getMyHand(this.worldRenderer.playerStateReactive.playerSkin, this.worldRenderer.playerStateReactive.onlineMode ? this.worldRenderer.playerStateReactive.username : undefined)
          },
          this.worldRenderer.playerStateReactive,
          'playerSkin',
          (newHand) => {
            if (newHand) {
              this.playerHand = newHand
              // trigger update
              this.updateItem()
            }
          },
          (oldHand) => {
            disposeObject(oldHand!, true)
          }
        )
      })
    }
  }

  updateItem() {
    if (!this.ready) return
    const item = this.offHand ? this.worldRenderer.playerStateReactive.heldItemOff : this.worldRenderer.playerStateReactive.heldItemMain
    if (item) {
      void this.setNewItem(item)
    } else if (this.offHand) {
      void this.setNewItem()
    } else {
      void this.setNewItem({
        type: 'hand',
      })
    }
  }

  initCameraGroup() {
    this.cameraGroup = new THREE.Mesh()
    this.armTransformGroup = new THREE.Group()
    this.armTransformGroup.matrixAutoUpdate = false
    this.cameraGroup.add(this.armTransformGroup)
  }

  startSwing() {
    this.swingAnimator?.startSwing()
  }

  stopSwing() {
    this.swingAnimator?.stopSwing()
  }

  render(originalCamera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer, ambientLight: THREE.AmbientLight, directionalLight: THREE.DirectionalLight) {
    if (!this.lastHeldItem) return
    const now = performance.now()
    if (this.lastUpdate && now - this.lastUpdate > 50) { // one tick
      void this.replaceItemModel(this.lastHeldItem)
    }

    // Only update swing animation
    if (this.swingAnimator?.isCurrentlySwinging() || this.swingAnimator?.debugParams.animationStage) {
      this.swingAnimator?.update()
    }
    // Idle animation disabled temporarily

    this.blockSwapAnimation?.switcher.update()

    const scene = new THREE.Scene()
    scene.add(this.cameraGroup)
    // Sync aspect ratio with main camera (vanilla renders hand in full viewport)
    if (this.camera.aspect !== originalCamera.aspect) {
      this.camera.aspect = originalCamera.aspect
      this.camera.updateProjectionMatrix()
    }
    this.updateCameraGroup()
    scene.add(ambientLight.clone())
    scene.add(directionalLight.clone())

    // Mirror the scene for offhand by scaling
    const { offHandDisplay } = this
    if (offHandDisplay) {
      this.cameraGroup.scale.x = -1
    }

    renderer.autoClear = false
    renderer.clearDepth()
    // Vanilla renders hand in full viewport (depth buffer cleared so hand is always on top)
    renderer.render(scene, this.camera)

    // Reset the mirroring after rendering
    if (offHandDisplay) {
      this.cameraGroup.scale.x = 1
    }
  }

  // worldTest () {
  //   const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshPhongMaterial({ color: 0x00_00_ff, transparent: true, opacity: 0.5 }))
  //   mesh.position.set(0.5, 0.5, 0.5)
  //   const group = new THREE.Group()
  //   group.add(mesh)
  //   group.position.set(-0.5, -0.5, -0.5)
  //   const outerGroup = new THREE.Group()
  //   outerGroup.add(group)
  //   outerGroup.position.set(this.camera.position.x, this.camera.position.y, this.camera.position.z)
  //   this.scene.add(outerGroup)

  //   new tweenJs.Tween(group.rotation).to({ z: THREE.MathUtils.degToRad(90) }, 1000).yoyo(true).repeat(Infinity).start()
  // }

  async playBlockSwapAnimation(forceState: 'appeared' | 'disappeared') {
    this.blockSwapAnimation ??= {
      switcher: new SmoothSwitcher(
        () => ({
          progress: this.equipProgress
        }),
        (property, value) => {
          if (property === 'progress') this.equipProgress = value
        },
        {
          progress: 4 // speed: units per second
        }
      )
    }

    const targetProgress = forceState === 'disappeared' ? 1 : 0
    let cancelled = false
    return new Promise<boolean>((resolve) => {
      this.blockSwapAnimation!.switcher.transitionTo(
        { progress: targetProgress },
        forceState,
        () => {
          if (!cancelled) resolve(true)
        },
        () => {
          cancelled = true
          resolve(false)
        }
      )
    })
  }

  isDifferentItem(block: HandItemBlock | undefined) {
    const Item = PrismarineItem(this.worldRenderer.version)
    if (!this.lastHeldItem) {
      return true
    }
    if (this.lastHeldItem.name !== block?.name) {
      return true
    }
    // eslint-disable-next-line sonarjs/prefer-single-boolean-return
    if (!Item.equal(this.lastHeldItem.fullItem, block?.fullItem ?? {}) || JSON.stringify(this.lastHeldItem.fullItem.components) !== JSON.stringify(block?.fullItem?.components)) {
      return true
    }

    return false
  }

  updateCameraGroup() {
    if (this.stopUpdate) return
    const { camera } = this
    this.cameraGroup.position.copy(camera.position)
    this.cameraGroup.rotation.copy(camera.rotation)

    const type = this.lastHeldItem?.type ?? 'hand'
    const swingProgress = this.swingAnimator?.getSwingProgress() ?? 0

    let matrix: THREE.Matrix4
    if (type === 'hand') {
      matrix = buildBareHandMatrix(swingProgress, this.equipProgress)
    } else {
      matrix = buildItemArmMatrix(swingProgress, this.equipProgress)
    }

    this.armTransformGroup.matrix.copy(matrix)
    this.armTransformGroup.matrixWorldNeedsUpdate = true
  }

  lastItemModelName: string | undefined
  private async createItemModel(handItem: HandItemBlock): Promise<{ model: THREE.Object3D; type: 'hand' | 'block' | 'item' } | undefined> {
    this.lastUpdate = performance.now()
    if (!handItem || (handItem.type === 'hand' && !this.playerHand)) return undefined

    let blockInner: THREE.Object3D | undefined
    if (handItem.type === 'item' || handItem.type === 'block') {
      const result = this.worldRenderer.entities.getItemMesh({
        ...handItem.fullItem,
        itemId: handItem.id,
      }, {
        'minecraft:display_context': 'firstperson',
        'minecraft:use_duration': this.worldRenderer.playerStateReactive.itemUsageTicks,
        'minecraft:using_item': !!this.worldRenderer.playerStateReactive.itemUsageTicks,
      }, false, this.lastItemModelName)
      if (result) {
        const { mesh: itemMesh, isBlock, modelName } = result
        if (isBlock) {
          blockInner = itemMesh
          handItem.type = 'block'
        } else {
          blockInner = itemMesh
          handItem.type = 'item'
        }
        this.lastItemModelName = modelName
      }
    } else {
      blockInner = this.playerHand!
    }
    if (!blockInner) return
    blockInner.name = 'holdingBlock'

    return { model: blockInner, type: handItem.type }
  }

  async replaceItemModel(handItem?: HandItemBlock): Promise<void> {
    // if switch animation is in progress, do not replace the item
    if (this.blockSwapAnimation?.switcher.isTransitioning) return

    if (!handItem) {
      this.holdingBlock?.removeFromParent()
      this.holdingBlock = undefined
      this.swingAnimator?.stopSwing()
      this.swingAnimator = undefined
      this.idleAnimator = undefined
      return
    }

    const result = await this.createItemModel(handItem)
    if (!result) return

    // Update the model without changing the group structure
    this.holdingBlock?.removeFromParent()
    this.holdingBlock = result.model
    this.armTransformGroup.add(result.model)


  }

  testUnknownBlockSwitch() {
    void this.setNewItem({
      type: 'item',
      name: 'minecraft:some-unknown-block',
      id: 0,
      fullItem: {}
    })
  }

  switchRequest = 0
  async setNewItem(handItem?: HandItemBlock) {
    if (!this.isDifferentItem(handItem)) return
    this.lastItemModelName = undefined
    const switchRequest = ++this.switchRequest
    this.lastHeldItem = handItem

    let playAppearAnimation = false
    if (this.holdingBlock) {
      playAppearAnimation = true
      const result = await this.playBlockSwapAnimation('disappeared')
      if (!result) return
      this.holdingBlock.removeFromParent()
      if (this.holdingBlock !== this.playerHand) {
        disposeObject(this.holdingBlock, false)
      }
      this.holdingBlock = undefined
    }

    if (!handItem) {
      this.swingAnimator = undefined
      this.idleAnimator = undefined
      this.blockSwapAnimation = undefined
      return
    }

    if (switchRequest !== this.switchRequest) return
    const result = await this.createItemModel(handItem)
    if (!result || switchRequest !== this.switchRequest) return

    this.holdingBlock = result.model
    this.armTransformGroup.add(this.holdingBlock)

    if (playAppearAnimation) {
      await this.playBlockSwapAnimation('appeared')
    }

    this.swingAnimator = new HandSwingAnimator()
    this.swingAnimator.type = result.type
    // Idle animation disabled temporarily — will be re-added with vanilla bobView
    this.idleAnimator = undefined
  }

}

class HandIdleAnimator {
  globalTime = 0
  lastTime = 0
  currentState: MovementState
  targetState: MovementState
  defaultPosition: { x: number; y: number; z: number; rotationX: number; rotationY: number; rotationZ: number }
  private readonly idleOffset = { y: 0, rotationZ: 0 }
  private readonly tween = new tweenJs.Group()
  private idleTween: tweenJs.Tween<{ y: number; rotationZ: number }> | null = null
  private readonly stateSwitcher: SmoothSwitcher

  // Debug parameters
  private readonly debugParams = {
    // Transition durations for different state changes
    walkingSpeed: 8,
    sprintingSpeed: 16,
    walkingAmplitude: { x: 1 / 30, y: 1 / 10, rotationZ: 0.25 },
    sprintingAmplitude: { x: 1 / 30, y: 1 / 10, rotationZ: 0.4 }
  }

  private readonly debugGui: DebugGui

  constructor(public handMesh: THREE.Object3D, public playerState: PlayerStateRenderer) {
    this.handMesh = handMesh
    this.globalTime = 0
    this.currentState = 'NOT_MOVING'
    this.targetState = 'NOT_MOVING'

    this.defaultPosition = {
      x: handMesh.position.x,
      y: handMesh.position.y,
      z: handMesh.position.z,
      rotationX: handMesh.rotation.x,
      rotationY: handMesh.rotation.y,
      rotationZ: handMesh.rotation.z
    }

    // Initialize state switcher with appropriate speeds
    this.stateSwitcher = new SmoothSwitcher(
      () => {
        return {
          x: this.handMesh.position.x,
          y: this.handMesh.position.y,
          z: this.handMesh.position.z,
          rotationX: this.handMesh.rotation.x,
          rotationY: this.handMesh.rotation.y,
          rotationZ: this.handMesh.rotation.z
        }
      },
      (property, value) => {
        switch (property) {
          case 'x': this.handMesh.position.x = value; break
          case 'y': this.handMesh.position.y = value; break
          case 'z': this.handMesh.position.z = value; break
          case 'rotationX': this.handMesh.rotation.x = value; break
          case 'rotationY': this.handMesh.rotation.y = value; break
          case 'rotationZ': this.handMesh.rotation.z = value; break
        }
      },
      {
        x: 2, // units per second
        y: 2,
        z: 2,
        rotation: Math.PI // radians per second
      }
    )

    // Initialize debug GUI
    this.debugGui = new DebugGui('idle_animator', this.debugParams)
    // this.debugGui.activate()
  }

  private startIdleAnimation() {
    if (this.idleTween) {
      this.idleTween.stop()
    }

    // Start from current position for smooth transition
    this.idleOffset.y = this.handMesh.position.y - this.defaultPosition.y
    this.idleOffset.rotationZ = this.handMesh.rotation.z - this.defaultPosition.rotationZ

    this.idleTween = new tweenJs.Tween(this.idleOffset, this.tween)
      .to({
        y: 0.05,
        rotationZ: 0.05
      }, 3000)
      .easing(tweenJs.Easing.Sinusoidal.InOut)
      .yoyo(true)
      .repeat(Infinity)
      .start()
  }

  private stopIdleAnimation() {
    if (this.idleTween) {
      this.idleTween.stop()
      this.idleOffset.y = 0
      this.idleOffset.rotationZ = 0
    }
  }

  private getStateTransform(state: MovementState, time: number) {
    switch (state) {
      case 'NOT_MOVING':
      case 'SNEAKING':
        return {
          x: this.defaultPosition.x,
          y: this.defaultPosition.y,
          z: this.defaultPosition.z,
          rotationX: this.defaultPosition.rotationX,
          rotationY: this.defaultPosition.rotationY,
          rotationZ: this.defaultPosition.rotationZ
        }
      case 'WALKING':
      case 'SPRINTING': {
        const speed = state === 'SPRINTING' ? this.debugParams.sprintingSpeed : this.debugParams.walkingSpeed
        const amplitude = state === 'SPRINTING' ? this.debugParams.sprintingAmplitude : this.debugParams.walkingAmplitude

        return {
          x: this.defaultPosition.x + Math.sin(time * speed) * amplitude.x,
          y: this.defaultPosition.y - Math.abs(Math.cos(time * speed)) * amplitude.y,
          z: this.defaultPosition.z,
          rotationX: this.defaultPosition.rotationX,
          rotationY: this.defaultPosition.rotationY,
          // rotationZ: this.defaultPosition.rotationZ + Math.sin(time * speed) * amplitude.rotationZ
          rotationZ: this.defaultPosition.rotationZ
        }
      }
    }
  }

  setState(newState: MovementState) {
    if (newState === this.targetState) return

    this.targetState = newState
    const noTransition = false
    if (this.currentState !== newState) {
      // Stop idle animation during state transitions
      this.stopIdleAnimation()

      // Calculate new state transform
      if (!noTransition) {
        // this.globalTime = 0
        const stateTransform = this.getStateTransform(newState, this.globalTime)

        // Start transition to new state
        this.stateSwitcher.transitionTo(stateTransform, newState)
        // this.updated = false
      }
      this.currentState = newState
    }
  }

  updated = false
  update() {
    this.stateSwitcher.update()

    const now = performance.now()
    const deltaTime = (now - this.lastTime) / 1000
    this.lastTime = now

    // Update global time based on current state
    if (!this.stateSwitcher.isTransitioning) {
      switch (this.currentState) {
        case 'NOT_MOVING':
        case 'SNEAKING':
          this.globalTime = Math.PI / 4
          break
        case 'SPRINTING':
        case 'WALKING':
          this.globalTime += deltaTime
          break
      }
    }

    // Check for state changes from player state
    if (this.playerState) {
      const newState = this.playerState.movementState
      if (newState !== this.targetState) {
        this.setState(newState)
      }
    }

    // If we're not transitioning between states and in a stable state that should have idle animation
    if (!this.stateSwitcher.isTransitioning &&
      (this.currentState === 'NOT_MOVING' || this.currentState === 'SNEAKING')) {
      // Start idle animation if not already running
      if (!this.idleTween?.isPlaying()) {
        this.startIdleAnimation()
      }
      // Update idle animation
      this.tween.update()

      // Apply idle offsets
      this.handMesh.position.y = this.defaultPosition.y + this.idleOffset.y
      this.handMesh.rotation.z = this.defaultPosition.rotationZ + this.idleOffset.rotationZ
    }

    // If we're in a movement state and not transitioning, update the movement animation
    if (!this.stateSwitcher.isTransitioning &&
      (this.currentState === 'WALKING' || this.currentState === 'SPRINTING')) {
      const stateTransform = this.getStateTransform(this.currentState, this.globalTime)
      Object.assign(this.handMesh.position, stateTransform)
      Object.assign(this.handMesh.rotation, {
        x: stateTransform.rotationX,
        y: stateTransform.rotationY,
        z: stateTransform.rotationZ
      })
      // this.stateSwitcher.transitionTo(stateTransform, this.currentState)
    }
  }

  getCurrentState() {
    return this.currentState
  }

  destroy() {
    this.stopIdleAnimation()
    this.stateSwitcher.forceFinish()
  }
}

class HandSwingAnimator {
  private animationTimer = 0
  private lastTime = 0
  private isAnimating = false
  private stopRequested = false
  private swingProgress = 0
  public type: 'hand' | 'block' | 'item' = 'hand'

  readonly debugParams = {
    animationTime: 250,
    animationStage: 0,
  }

  private readonly debugGui: DebugGui

  constructor() {
    this.debugGui = new DebugGui('hand_animator', this.debugParams, undefined, {
      animationStage: { min: 0, max: 1, step: 0.01 },
    })
  }

  update() {
    if (!this.isAnimating && !this.debugParams.animationStage) {
      this.swingProgress = 0
      return
    }

    const now = performance.now()
    const deltaTime = (now - this.lastTime) / 1000
    this.lastTime = now

    this.animationTimer += deltaTime * 1000

    const stage = this.debugParams.animationStage || Math.min(this.animationTimer / this.debugParams.animationTime, 1)

    if (stage >= 1) {
      if (this.stopRequested) {
        this.isAnimating = false
        this.stopRequested = false
        this.animationTimer = 0
        this.swingProgress = 0
        return
      }
      this.animationTimer = 0
      this.swingProgress = 0
      return
    }

    this.swingProgress = stage
  }

  getSwingProgress(): number {
    return this.swingProgress
  }

  startSwing() {
    this.stopRequested = false
    if (this.isAnimating) return
    this.isAnimating = true
    this.animationTimer = 0
    this.lastTime = performance.now()
  }

  stopSwing() {
    if (!this.isAnimating) return
    this.stopRequested = true
  }

  isCurrentlySwinging() {
    return this.isAnimating
  }
}

export const getBlockMeshFromModel = (material: THREE.Material, model: BlockModel, name: string, blockProvider: WorldBlockProvider, mcData: IndexedData) => {
  const worldRenderModel = blockProvider.transformModel(model, {
    name,
    properties: {}
  }) as any
  return getThreeBlockModelGroup(material, [[worldRenderModel]], undefined, 'plains', mcData)
}
