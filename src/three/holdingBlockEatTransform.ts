import type { UseItemSession } from '../playerState/types'

export interface EatTransform {
  jiggleY: number
  translation: {
    x: number
    y: number
    z: number
  }
  rotationDegrees: {
    x: number
    y: number
    z: number
  }
}

export type EatTransformSession = Pick<UseItemSession, 'hand' | 'action' | 'durationTicks' | 'elapsedTicks' | 'status'>

/**
 * This renderer uses equipProgress 0 = fully visible, 1 = fully hidden.
 * Vanilla itemUsed hides the hand once, then interpolates back to visible.
 */
export const EAT_ITEM_USED_HIDDEN_PROGRESS = 1
export const EAT_ITEM_USED_VISIBLE_PROGRESS = 0

export type EatItemUsedStart = {
  started: true
  lastEatSessionId: number
  equipProgress: typeof EAT_ITEM_USED_HIDDEN_PROGRESS
  appearedTarget: typeof EAT_ITEM_USED_VISIBLE_PROGRESS
  playState: 'appeared'
}

/**
 * On a new eat/drink session.id: interrupt any in-flight swap, hide the item,
 * then play the appeared animation so equipProgress interpolates 1 → 0.
 * Same session.id is a no-op so this is not written every tick.
 */
export function startEatItemUsedDip(input: {
  sessionId: number
  lastEatSessionId: number | undefined
  forceFinish?: () => void
}): EatItemUsedStart | { started: false } {
  if (input.lastEatSessionId === input.sessionId) return { started: false }
  input.forceFinish?.()
  return {
    started: true,
    lastEatSessionId: input.sessionId,
    equipProgress: EAT_ITEM_USED_HIDDEN_PROGRESS,
    appearedTarget: EAT_ITEM_USED_VISIBLE_PROGRESS,
    playState: 'appeared'
  }
}

/**
 * Returns the first-person eating/drinking offsets from ItemInHandRenderer.applyEatTransform.
 * The fixed arm side is deliberately omitted: the holding scene mirrors the offhand group.
 */
export function computeEatTransform(h: number, g: number): EatTransform {
  const i = 1 - Math.pow(h, 27)

  return {
    jiggleY: h < 0.8 ? Math.abs(Math.cos((g / 4) * Math.PI) * 0.1) : 0,
    translation: {
      x: i * 0.6,
      y: i * -0.5,
      z: i * 0
    },
    rotationDegrees: {
      x: i * 10,
      y: i * 90,
      z: i * 30
    }
  }
}

export function shouldApplyEatTransform(session: EatTransformSession | undefined, hand: 0 | 1): boolean {
  return (
    session !== undefined &&
    session.hand === hand &&
    (session.status === 'active' || session.status === 'awaitingCompletion') &&
    (session.action === 'EAT' || session.action === 'DRINK') &&
    session.durationTicks > 0 &&
    session.elapsedTicks < session.durationTicks
  )
}
