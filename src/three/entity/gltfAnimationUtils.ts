import * as THREE from 'three'

export interface AnimationState {
  mixer: THREE.AnimationMixer
  animations: THREE.AnimationClip[]
  actions: Map<string, THREE.AnimationAction>
  speed: number
  loop: boolean
}

export class AnimationManager {
  private readonly clock = new THREE.Clock()
  private readonly animatedObjects = new Set<THREE.Object3D>()
  state!: AnimationState

  constructor(
    public object: THREE.Object3D,
    public animations: THREE.AnimationClip[]
  ) {
    // Private constructor for singleton
  }

  /**
   * Creates an animation state for a Three.js object
   */
  createAnimationState(): AnimationState {
    const mixer = new THREE.AnimationMixer(this.object)
    const actions = new Map<string, THREE.AnimationAction>()

    // Store clips as actions for easy access
    for (const clip of this.animations) {
      actions.set(clip.name, mixer.clipAction(clip))
    }

    this.state = {
      mixer,
      animations: this.animations,
      actions,
      speed: 1,
      loop: true
    }

    // Set up onBeforeRender callback for renderable objects
    // onBeforeRender only works on renderable objects (Mesh, Line, Points, Sprite)
    this.object.traverse((child) => {
      if (child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.Points || child instanceof THREE.Sprite) {
        const originalOnBeforeRender = child.onBeforeRender
        child.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
          const delta = this.clock.getDelta()
          mixer.update(delta)
          // Call original onBeforeRender if it existed
          originalOnBeforeRender?.(renderer, scene, camera, geometry, material, group)
        }
      }
    })

    // Track animated objects
    this.animatedObjects.add(this.object)

    return this.state
  }

  /**
   * Plays an animation by name
   */
  playAnimation(name: string, loop?: boolean, speed?: number): boolean {
    const action = this.state.actions.get(name)
    if (!action) {
      console.warn(`Animation "${name}" not found`)
      return false
    }

    // Stop any existing animations
    this.state.mixer.stopAllAction()

    // Configure animation
    const shouldLoop = loop ?? this.state.loop
    action.setLoop(shouldLoop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
    action.clampWhenFinished = !shouldLoop

    if (speed === undefined) {
      action.timeScale = this.state.speed
    } else {
      action.timeScale = speed
    }

    action.reset().fadeIn(0.1).play()
    return true
  }

  /**
   * Updates animation parameters for a state
   */
  updateAnimationParams(speed?: number, loop?: boolean): void {
    if (speed !== undefined) {
      this.state.speed = speed
    }
    if (loop !== undefined) {
      this.state.loop = loop
    }

    // Update existing actions
    for (const action of this.state.actions.values()) {
      if (speed !== undefined) {
        action.timeScale = speed
      }
      if (loop !== undefined) {
        action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
        action.clampWhenFinished = !loop
      }
    }
  }

  /**
   * Stops all animations for a state
   */
  stopAnimations(): void {
    this.state.mixer.stopAllAction()
  }

  /**
   * Gets the current clock delta (useful for manual updates)
   */
  getDelta(): number {
    return this.clock.getDelta()
  }
}

/**
 * Convenience function to create and manage animations for an object
 */
export function createAnimatedObject(
  object: THREE.Object3D,
  animations: THREE.AnimationClip[]
) {
  const manager = new AnimationManager(object, animations)
  manager.createAnimationState()

  return manager
}
