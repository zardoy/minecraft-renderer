import * as tweenJs from '@tweenjs/tween.js'
import { AnimationController } from './animationController'

export type StateProperties = Record<string, number>
export type StateGetterFn = () => StateProperties
export type StateSetterFn = (property: string, value: number) => void

// Speed in units per second for each property type
const DEFAULT_SPEEDS = {
  x: 3000, // pixels/units per second
  y: 3000,
  z: 3000,
  rotation: Math.PI, // radians per second
  scale: 1, // scale units per second
  default: 3000 // default speed for unknown properties
}

export class SmoothSwitcher {
  private readonly animationController = new AnimationController()
  // private readonly currentState: StateProperties = {}
  private readonly defaultState: StateProperties
  private readonly speeds: Record<string, number>
  public currentStateName = ''
  public transitioningToStateName = ''

  constructor(
    public getState: StateGetterFn,
    public setState: StateSetterFn,
    speeds?: Partial<Record<string, number>>
  ) {
    // Initialize speeds with defaults and overrides
    this.speeds = { ...DEFAULT_SPEEDS }
    if (speeds) {
      Object.assign(this.speeds, speeds)
    }

    // Store initial values
    this.defaultState = this.getState()
  }

  /**
   * Calculate transition duration based on the largest property change
   */
  private calculateDuration(newState: Partial<StateProperties>): number {
    let maxDuration = 0
    const currentState = this.getState()

    for (const [key, targetValue] of Object.entries(newState)) {
      const currentValue = currentState[key]
      const diff = Math.abs(targetValue! - currentValue)
      const speed = this.getPropertySpeed(key)
      const duration = (diff / speed) * 1000 // Convert to milliseconds

      maxDuration = Math.max(maxDuration, duration)
    }

    // Ensure minimum duration of 50ms and maximum of 2000ms
    return Math.min(Math.max(maxDuration, 200), 2000)
  }

  private getPropertySpeed(property: string): number {
    // Check for specific property speed
    if (property in this.speeds) {
      return this.speeds[property]
    }

    // Check for property type (rotation, scale, etc.)
    if (property.toLowerCase().includes('rotation')) return this.speeds.rotation
    if (property.toLowerCase().includes('scale')) return this.speeds.scale
    if (property.toLowerCase() === 'x' || property.toLowerCase() === 'y' || property.toLowerCase() === 'z') {
      return this.speeds[property]
    }

    return this.speeds.default
  }

  /**
   * Start a transition to a new state
   * @param newState Partial state - only need to specify properties that change
   * @param easing Easing function to use
   */
  startTransition(
    newState: Partial<StateProperties>,
    stateName?: string,
    onEnd?: () => void,
    easing: (amount: number) => number = tweenJs.Easing.Linear.None,
    onCancelled?: () => void
  ): void {
    if (this.isTransitioning) {
      this.animationController.forceFinish(false)
    }

    this.transitioningToStateName = stateName ?? ''
    const state = this.getState()

    const duration = this.calculateDuration(newState)
    // console.log('duration', duration, JSON.stringify(state), JSON.stringify(newState))

    void this.animationController.startAnimation(() => {
      const group = new tweenJs.Group()
      new tweenJs.Tween(state, group)
        .to(newState, duration)
        .easing(easing)
        .onUpdate(obj => {
          for (const key of Object.keys(obj)) {
            this.setState(key, obj[key])
          }
        })
        .onComplete(() => {
          this.animationController.forceFinish()
          this.currentStateName = this.transitioningToStateName
          this.transitioningToStateName = ''
          onEnd?.()
        })
        .start()
      return group
    }, onCancelled)
  }

  /**
   * Reset to default state
   */
  reset(): void {
    this.startTransition(this.defaultState)
  }

  /**
   * Update the animation (should be called in your render/update loop)
   */
  update(): void {
    this.animationController.update()
  }

  /**
   * Force finish the current transition
   */
  forceFinish(): void {
    this.animationController.forceFinish()
  }

  /**
   * Start a new transition to the specified state
   */
  transitionTo(newState: Partial<StateProperties>, stateName?: string, onEnd?: () => void, onCancelled?: () => void): void {
    this.startTransition(newState, stateName, onEnd, tweenJs.Easing.Linear.None, onCancelled)
  }

  /**
   * Get the current value of a property
   */
  getCurrentValue(property: string): number {
    return this.getState()[property]
  }

  /**
   * Check if currently transitioning
   */
  get isTransitioning(): boolean {
    return this.animationController.isActive
  }
}
