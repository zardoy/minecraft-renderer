import * as THREE from 'three'
import * as tweenJs from '@tweenjs/tween.js'
import PrismarineItem from 'prismarine-item'
import { WorldBlockProvider } from 'mc-assets/dist/worldBlockProvider'
import { BlockModel } from 'mc-assets'
import { DebugGui } from '../lib/DebugGui'
import { SmoothSwitcher } from '../lib/smoothSwitcher'
import { watchProperty } from '../lib/utils/proxy'
import { subscribeKey } from 'valtio/utils'
import { getMyHand } from './handLegacy'
import { WorldRendererThree } from './worldRendererThree'
import { disposeObject } from './threeJsUtils'
import { HandItemBlock, MovementState } from '../playerState/types'
import { PlayerStateRenderer } from '../playerState/playerState'
import { getThreeBlockModelGroup } from '../mesher/standaloneRenderer'
import { IndexedData } from 'minecraft-data'
import { WorldRendererConfig } from '../graphicsBackend'
import { IHoldingBlock } from './holdingBlockTypes'

const rotationPositionData = {
  itemRight: {
    'rotation': [
      0,
      -90,
      25
    ],
    'translation': [
      1.13,
      3.2,
      1.13
    ],
    'scale': [
      0.68,
      0.68,
      0.68
    ]
  },
  itemLeft: {
    'rotation': [
      0,
      90,
      -25
    ],
    'translation': [
      1.13,
      3.2,
      1.13
    ],
    'scale': [
      0.68,
      0.68,
      0.68
    ]
  },
  blockRight: {
    'rotation': [
      0,
      45,
      0
    ],
    'translation': [
      0,
      0,
      0
    ],
    'scale': [
      0.4,
      0.4,
      0.4
    ]
  },
  blockLeft: {
    'rotation': [
      0,
      225,
      0
    ],
    'translation': [
      0,
      0,
      0
    ],
    'scale': [
      0.4,
      0.4,
      0.4
    ]
  }
}

export default class HoldingBlockLegacy implements IHoldingBlock {
  // TODO refactor with the tree builder for better visual understanding
  holdingBlock: THREE.Object3D | undefined = undefined
  blockSwapAnimation: {
    switcher: SmoothSwitcher
    // hidden: boolean
  } | undefined = undefined
  cameraGroup = new THREE.Mesh()
  objectOuterGroup = new THREE.Group() // 3
  objectInnerGroup = new THREE.Group() // 4
  holdingBlockInnerGroup = new THREE.Group() // 5
  camera = new THREE.PerspectiveCamera(75, 1, 0.1, 100)
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
  private disposed = false
  unsubs: Array<() => void> = []

  constructor(public worldRenderer: WorldRendererThree, public offHand = false) {
    this.initCameraGroup()
    this.unsubs.push(subscribeKey(this.worldRenderer.playerStateReactive, 'heldItemMain', () => {
      if (!this.offHand) {
        this.updateItem()
      }
    }))
    this.unsubs.push(subscribeKey(this.worldRenderer.playerStateReactive, 'heldItemOff', () => {
      if (this.offHand) {
        this.updateItem()
      }
    }))
    this.config = worldRenderer.displayOptions.inWorldRenderingConfig

    this.offHandDisplay = this.offHand
    // this.offHandDisplay = true
    if (!this.offHand) {
      // load default hand
      void getMyHand().then((hand) => {
        if (this.disposed) return
        this.playerHand = hand
        // trigger update
        this.updateItem()
      }).then(() => {
        if (this.disposed) return
        // now watch over the player skin
        const unsub = watchProperty(
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
        this.unsubs.push(unsub)
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

    // Only update idle animation if not swinging
    if (this.swingAnimator?.isCurrentlySwinging() || this.swingAnimator?.debugParams.animationStage) {
      this.swingAnimator?.update()
    } else {
      this.idleAnimator?.update()
    }

    this.blockSwapAnimation?.switcher.update()

    const scene = new THREE.Scene()
    scene.add(this.cameraGroup)
    // if (this.camera.aspect !== originalCamera.aspect) {
    //   this.camera.aspect = originalCamera.aspect
    //   this.camera.updateProjectionMatrix()
    // }
    this.updateCameraGroup()
    scene.add(ambientLight.clone())
    scene.add(directionalLight.clone())

    const viewerSize = renderer.getSize(new THREE.Vector2())
    const minSize = Math.min(viewerSize.width, viewerSize.height)
    const x = viewerSize.width - minSize

    // Mirror the scene for offhand by scaling
    const { offHandDisplay } = this
    if (offHandDisplay) {
      this.cameraGroup.scale.x = -1
    }

    renderer.autoClear = false
    renderer.clearDepth()
    if (this.offHandDisplay) {
      renderer.setViewport(0, 0, minSize, minSize)
    } else {
      const x = viewerSize.width - minSize
      // if (x) x -= x / 4
      renderer.setViewport(x, 0, minSize, minSize)
    }
    renderer.render(scene, this.camera)
    renderer.setViewport(0, 0, viewerSize.width, viewerSize.height)

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
          y: this.objectInnerGroup.position.y
        }),
        (property, value) => {
          if (property === 'y') this.objectInnerGroup.position.y = value
        },
        {
          y: 16 // units per second
        }
      )
    }

    const newState = forceState
    // if (forceState && newState !== forceState) {
    //   throw new Error(`forceState does not match current state ${forceState} !== ${newState}`)
    // }

    const targetY = this.objectInnerGroup.position.y + (this.objectInnerGroup.scale.y * 1.5 * (newState === 'appeared' ? 1 : -1))

    // if (newState === this.blockSwapAnimation.switcher.transitioningToStateName) {
    //   return false
    // }

    let cancelled = false
    return new Promise<boolean>((resolve) => {
      this.blockSwapAnimation!.switcher.transitionTo(
        { y: targetY },
        newState,
        () => {
          if (!cancelled) {
            resolve(true)
          }
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

    // const viewerSize = viewer.renderer.getSize(new THREE.Vector2())
    // const aspect = viewerSize.width / viewerSize.height
    const aspect = 1


    // Adjust the position based on the aspect ratio
    const { position, scale: scaleData } = this.getHandHeld3d()
    const distance = -position.z
    const side = this.offHandModeLegacy ? -1 : 1
    this.objectOuterGroup.position.set(
      distance * position.x * aspect * side,
      distance * position.y,
      -distance
    )

    // const scale = Math.min(0.8, Math.max(1, 1 * aspect))
    const scale = scaleData * 2.22 * 0.2
    this.objectOuterGroup.scale.set(scale, scale, scale)
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
          itemMesh.position.set(0.5, 0.5, 0.5)
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

    const rotationDeg = this.getHandHeld3d().rotation
    blockInner.rotation.x = THREE.MathUtils.degToRad(rotationDeg.x)
    blockInner.rotation.y = THREE.MathUtils.degToRad(rotationDeg.y)
    blockInner.rotation.z = THREE.MathUtils.degToRad(rotationDeg.z)

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
    this.holdingBlockInnerGroup.add(result.model)


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
      // play disappear animation
      playAppearAnimation = true
      const result = await this.playBlockSwapAnimation('disappeared')
      if (!result) return
      this.holdingBlock?.removeFromParent()
      this.holdingBlock = undefined
    }

    if (!handItem) {
      this.swingAnimator?.stopSwing()
      this.swingAnimator = undefined
      this.idleAnimator = undefined
      this.blockSwapAnimation = undefined
      return
    }

    if (switchRequest !== this.switchRequest) return
    const result = await this.createItemModel(handItem)
    if (!result || switchRequest !== this.switchRequest) return

    const blockOuterGroup = new THREE.Group()
    this.holdingBlockInnerGroup.removeFromParent()
    this.holdingBlockInnerGroup = new THREE.Group()
    this.holdingBlockInnerGroup.add(result.model)
    blockOuterGroup.add(this.holdingBlockInnerGroup)
    this.holdingBlock = result.model
    this.objectInnerGroup = new THREE.Group()
    this.objectInnerGroup.add(blockOuterGroup)
    this.objectInnerGroup.position.set(-0.5, -0.5, -0.5)
    if (playAppearAnimation) {
      this.objectInnerGroup.position.y -= this.objectInnerGroup.scale.y * 1.5
    }
    Object.assign(blockOuterGroup.position, { x: 0.5, y: 0.5, z: 0.5 })

    this.objectOuterGroup = new THREE.Group()
    this.objectOuterGroup.add(this.objectInnerGroup)

    this.cameraGroup.add(this.objectOuterGroup)
    const rotationDeg = this.getHandHeld3d().rotation
    this.objectOuterGroup.rotation.y = THREE.MathUtils.degToRad(rotationDeg.yOuter)

    if (playAppearAnimation) {
      await this.playBlockSwapAnimation('appeared')
    }

    this.swingAnimator = new HandSwingAnimator(this.holdingBlockInnerGroup)
    this.swingAnimator.type = result.type
    if (this.config.viewBobbing) {
      this.idleAnimator = new HandIdleAnimator(this.holdingBlockInnerGroup, this.worldRenderer.playerStateReactive)
    }
  }

  getHandHeld3d() {
    const type = this.lastHeldItem?.type ?? 'hand'
    const side = this.offHandModeLegacy ? 'Left' : 'Right'

    let scale = 0.8 * 1.15 // default scale for hand
    let position = {
      x: 0.4,
      y: -0.7,
      z: -0.45
    }
    let rotation = {
      x: -32.4,
      y: 42.8,
      z: -41.3,
      yOuter: 0
    }

    if (type === 'item') {
      const itemData = rotationPositionData[`item${side}`]
      position = {
        x: -0.05,
        y: -0.7,
        z: -0.45
      }
      rotation = {
        x: itemData.rotation[0],
        y: itemData.rotation[1],
        z: itemData.rotation[2],
        yOuter: 0
      }
      scale = itemData.scale[0] * 1.15
    } else if (type === 'block') {
      const blockData = rotationPositionData[`block${side}`]
      position = {
        x: 0.4,
        y: -0.7,
        z: -0.45
      }
      rotation = {
        x: blockData.rotation[0],
        y: blockData.rotation[1],
        z: blockData.rotation[2],
        yOuter: 0
      }
      scale = blockData.scale[0] * 1.15
    }

    return {
      rotation,
      position,
      scale
    }
  }

  dispose() {
    this.disposed = true
    this.ready = false
    this.unsubs.forEach(fn => fn())
    this.unsubs = []
    this.idleAnimator?.destroy()
    this.idleAnimator = undefined
    this.swingAnimator?.stopSwing()
    this.swingAnimator = undefined
    this.blockSwapAnimation?.switcher.forceFinish()
    this.blockSwapAnimation = undefined
    disposeObject(this.cameraGroup, true)
    disposeObject(this.objectOuterGroup, true)
    disposeObject(this.objectInnerGroup, true)
    disposeObject(this.holdingBlockInnerGroup, true)
    this.holdingBlock = undefined
    if (this.playerHand) {
      disposeObject(this.playerHand, true)
      this.playerHand = undefined
    }
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
  private readonly PI = Math.PI
  private animationTimer = 0
  private lastTime = 0
  private isAnimating = false
  private stopRequested = false
  private readonly originalRotation: THREE.Euler
  private readonly originalPosition: THREE.Vector3
  private readonly originalScale: THREE.Vector3

  readonly debugParams = {
    // Animation timing
    animationTime: 250,
    animationStage: 0,
    useClassicSwing: true,

    // Item/Block animation parameters
    itemSwingXPosScale: -0.8,
    itemSwingYPosScale: 0.2,
    itemSwingZPosScale: -0.2,
    itemHeightScale: -0.6,
    itemPreswingRotY: 45,
    itemSwingXRotAmount: -30,
    itemSwingYRotAmount: -35,
    itemSwingZRotAmount: -5,

    // Hand/Arm animation parameters
    armSwingXPosScale: -0.3,
    armSwingYPosScale: 0.4,
    armSwingZPosScale: -0.4,
    armSwingYRotAmount: 70,
    armSwingZRotAmount: -20,
    armHeightScale: -0.6
  }

  private readonly debugGui: DebugGui

  public type: 'hand' | 'block' | 'item' = 'hand'

  constructor(public handMesh: THREE.Object3D) {
    this.handMesh = handMesh
    // Store initial transforms
    this.originalRotation = handMesh.rotation.clone()
    this.originalPosition = handMesh.position.clone()
    this.originalScale = handMesh.scale.clone()

    // Initialize debug GUI
    this.debugGui = new DebugGui('hand_animator', this.debugParams, undefined, {
      animationStage: {
        min: 0,
        max: 1,
        step: 0.01
      },
      // Add ranges for all animation parameters
      itemSwingXPosScale: { min: -2, max: 2, step: 0.1 },
      itemSwingYPosScale: { min: -2, max: 2, step: 0.1 },
      itemSwingZPosScale: { min: -2, max: 2, step: 0.1 },
      itemHeightScale: { min: -2, max: 2, step: 0.1 },
      itemPreswingRotY: { min: -180, max: 180, step: 5 },
      itemSwingXRotAmount: { min: -180, max: 180, step: 5 },
      itemSwingYRotAmount: { min: -180, max: 180, step: 5 },
      itemSwingZRotAmount: { min: -180, max: 180, step: 5 },
      armSwingXPosScale: { min: -2, max: 2, step: 0.1 },
      armSwingYPosScale: { min: -2, max: 2, step: 0.1 },
      armSwingZPosScale: { min: -2, max: 2, step: 0.1 },
      armSwingYRotAmount: { min: -180, max: 180, step: 5 },
      armSwingZRotAmount: { min: -180, max: 180, step: 5 },
      armHeightScale: { min: -2, max: 2, step: 0.1 }
    })
    // this.debugGui.activate()
  }

  update() {
    if (!this.isAnimating && !this.debugParams.animationStage) {
      // If not animating, ensure we're at original position
      this.handMesh.rotation.copy(this.originalRotation)
      this.handMesh.position.copy(this.originalPosition)
      this.handMesh.scale.copy(this.originalScale)
      return
    }

    const now = performance.now()
    const deltaTime = (now - this.lastTime) / 1000
    this.lastTime = now

    // Update animation progress
    this.animationTimer += deltaTime * 1000 // Convert to ms

    // Calculate animation stage (0 to 1)
    const stage = this.debugParams.animationStage || Math.min(this.animationTimer / this.debugParams.animationTime, 1)

    if (stage >= 1) {
      // Animation complete
      if (this.stopRequested) {
        // If stop was requested, actually stop now that we've completed a swing
        this.isAnimating = false
        this.stopRequested = false
        this.animationTimer = 0
        this.handMesh.rotation.copy(this.originalRotation)
        this.handMesh.position.copy(this.originalPosition)
        this.handMesh.scale.copy(this.originalScale)
        return
      }
      // Otherwise reset timer and continue
      this.animationTimer = 0
      return
    }

    // Start from original transforms
    this.handMesh.rotation.copy(this.originalRotation)
    this.handMesh.position.copy(this.originalPosition)
    this.handMesh.scale.copy(this.originalScale)

    // Calculate swing progress
    const swingProgress = stage
    const sqrtProgress = Math.sqrt(swingProgress)
    const sinProgress = Math.sin(swingProgress * this.PI)
    const sinSqrtProgress = Math.sin(sqrtProgress * this.PI)

    if (this.type === 'hand') {
      // Hand animation
      const xOffset = this.debugParams.armSwingXPosScale * sinSqrtProgress
      const yOffset = this.debugParams.armSwingYPosScale * Math.sin(sqrtProgress * this.PI * 2)
      const zOffset = this.debugParams.armSwingZPosScale * sinProgress

      this.handMesh.position.x += xOffset
      this.handMesh.position.y += yOffset + this.debugParams.armHeightScale * swingProgress
      this.handMesh.position.z += zOffset

      // Rotations
      this.handMesh.rotation.y += THREE.MathUtils.degToRad(this.debugParams.armSwingYRotAmount * sinSqrtProgress)
      this.handMesh.rotation.z += THREE.MathUtils.degToRad(this.debugParams.armSwingZRotAmount * sinProgress)
    } else {
      // Item/Block animation
      const xOffset = this.debugParams.itemSwingXPosScale * sinSqrtProgress
      const yOffset = this.debugParams.itemSwingYPosScale * Math.sin(sqrtProgress * this.PI * 2)
      const zOffset = this.debugParams.itemSwingZPosScale * sinProgress

      this.handMesh.position.x += xOffset
      this.handMesh.position.y += yOffset + this.debugParams.itemHeightScale * swingProgress
      this.handMesh.position.z += zOffset

      // Pre-swing rotation
      this.handMesh.rotation.y += THREE.MathUtils.degToRad(this.debugParams.itemPreswingRotY)

      // Swing rotations
      this.handMesh.rotation.x += THREE.MathUtils.degToRad(this.debugParams.itemSwingXRotAmount * sinProgress)
      this.handMesh.rotation.y += THREE.MathUtils.degToRad(this.debugParams.itemSwingYRotAmount * sinSqrtProgress)
      this.handMesh.rotation.z += THREE.MathUtils.degToRad(this.debugParams.itemSwingZRotAmount * sinProgress)
    }
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
