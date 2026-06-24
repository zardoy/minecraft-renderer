import * as tweenJs from '@tweenjs/tween.js'

export class AnimationController {
  private currentAnimation: tweenJs.Group | null = null
  private isAnimating = false
  private cancelRequested = false
  private completionCallbacks: Array<() => void> = []
  private currentCancelCallback: (() => void) | null = null

  /** Main method */
  async startAnimation(createAnimation: () => tweenJs.Group, onCancelled?: () => void): Promise<void> {
    if (this.isAnimating) {
      await this.cancelCurrentAnimation()
    }

    return new Promise(resolve => {
      this.isAnimating = true
      this.cancelRequested = false
      this.currentCancelCallback = onCancelled ?? null
      this.currentAnimation = createAnimation()

      this.completionCallbacks.push(() => {
        this.isAnimating = false
        this.currentAnimation = null
        resolve()
      })
    })
  }

  /** Main method */
  async cancelCurrentAnimation(): Promise<void> {
    if (!this.isAnimating) return

    if (this.currentCancelCallback) {
      const callback = this.currentCancelCallback
      this.currentCancelCallback = null
      callback()
    }

    return new Promise(resolve => {
      this.cancelRequested = true
      this.completionCallbacks.push(() => {
        resolve()
      })
    })
  }

  animationCycleFinish() {
    if (this.cancelRequested) this.forceFinish()
  }

  forceFinish(callComplete = true) {
    if (!this.isAnimating) return

    if (this.currentAnimation) {
      for (const tween of this.currentAnimation.getAll()) tween.stop()
      this.currentAnimation.removeAll()
      this.currentAnimation = null
    }

    this.isAnimating = false
    this.cancelRequested = false

    const callbacks = [...this.completionCallbacks]
    this.completionCallbacks = []
    if (callComplete) {
      for (const cb of callbacks) cb()
    }
  }

  /** Required method */
  update() {
    if (this.currentAnimation) {
      this.currentAnimation.update()
    }
  }

  get isActive() {
    return this.isAnimating
  }

  get shouldCancel() {
    return this.cancelRequested
  }
}
