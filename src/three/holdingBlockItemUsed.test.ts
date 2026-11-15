import { describe, expect, test, vi } from 'vitest'
import { EAT_ITEM_USED_HIDDEN_PROGRESS, EAT_ITEM_USED_VISIBLE_PROGRESS, startEatItemUsedDip } from './holdingBlockEatTransform'

describe('startEatItemUsedDip', () => {
  test('hides the item once then targets the appeared/visible progress', () => {
    const forceFinish = vi.fn()
    const started = startEatItemUsedDip({
      sessionId: 3,
      lastEatSessionId: undefined,
      forceFinish
    })

    expect(forceFinish).toHaveBeenCalledOnce()
    expect(started).toEqual({
      started: true,
      lastEatSessionId: 3,
      equipProgress: EAT_ITEM_USED_HIDDEN_PROGRESS,
      appearedTarget: EAT_ITEM_USED_VISIBLE_PROGRESS,
      playState: 'appeared'
    })
    expect(started.started && started.equipProgress).toBe(1)
    expect(started.started && started.appearedTarget).toBe(0)
    expect(EAT_ITEM_USED_HIDDEN_PROGRESS).not.toBe(EAT_ITEM_USED_VISIBLE_PROGRESS)

    const sameSession = startEatItemUsedDip({
      sessionId: 3,
      lastEatSessionId: 3,
      forceFinish
    })
    expect(sameSession).toEqual({ started: false })
    expect(forceFinish).toHaveBeenCalledOnce()
  })

  test('a later session id starts a fresh hidden→visible dip', () => {
    const forceFinish = vi.fn()
    const next = startEatItemUsedDip({
      sessionId: 4,
      lastEatSessionId: 3,
      forceFinish
    })

    expect(forceFinish).toHaveBeenCalledOnce()
    expect(next.started).toBe(true)
    if (!next.started) return
    expect(next.equipProgress).toBe(1)
    expect(next.appearedTarget).toBe(0)
    expect(next.playState).toBe('appeared')
  })
})
