import HoldingBlock from './holdingBlock'
import HoldingBlockLegacy from './holdingBlockLegacy'
import type { IHoldingBlock } from './holdingBlockTypes'
import type { WorldRendererThree } from './worldRendererThree'

export function createHoldingBlock(
  worldRenderer: WorldRendererThree,
  offHand: boolean = false
): IHoldingBlock {
  const config = worldRenderer.displayOptions.inWorldRenderingConfig
  if (config.handRenderer === 'legacy') {
    return new HoldingBlockLegacy(worldRenderer, offHand)
  }
  return new HoldingBlock(worldRenderer, offHand)
}
