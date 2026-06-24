import { test, expect, vi, beforeEach } from 'vitest'
import * as THREE from 'three'

const renderSignMock = vi.fn()
vi.mock('../../sign-renderer', () => ({
  renderSign: (...args: unknown[]) => renderSignMock(...args)
}))

vi.mock('prismarine-chat', () => ({
  default: () => () => ({})
}))

import { getSignTexture, releaseSignTexture, disposeAllSignTextures } from '../signTextureCache'
import type { WorldRendererThree } from '../worldRendererThree'

function createWorldRenderer(): WorldRendererThree {
  return { version: '1.20' } as WorldRendererThree
}

function stubCanvas() {
  return { width: 64, height: 32 } as HTMLCanvasElement
}

beforeEach(() => {
  renderSignMock.mockReset()
  renderSignMock.mockImplementation(() => stubCanvas())
  disposeAllSignTextures()
})

test('getSignTexture: same content at different positions shares one texture', () => {
  const wr = createWorldRenderer()
  const blockEntity = { Text1: '{"text":"Hello"}' }

  const tex1 = getSignTexture(wr, blockEntity, false)
  const tex2 = getSignTexture(wr, { ...blockEntity }, false)

  expect(tex1).toBeDefined()
  expect(tex2).toBe(tex1)
  expect(renderSignMock).toHaveBeenCalledTimes(1)
})

test('getSignTexture: different text yields different textures', () => {
  const wr = createWorldRenderer()

  const tex1 = getSignTexture(wr, { Text1: '{"text":"Hello"}' }, false)!
  const tex2 = getSignTexture(wr, { Text1: '{"text":"World"}' }, false)!

  expect(tex2).not.toBe(tex1)
  expect(renderSignMock).toHaveBeenCalledTimes(2)
})

test('releaseSignTexture: partial release keeps texture in cache', () => {
  const wr = createWorldRenderer()
  const blockEntity = { Text1: '{"text":"Hello"}' }

  const tex1 = getSignTexture(wr, blockEntity, false)!
  const tex2 = getSignTexture(wr, blockEntity, false)!
  expect(tex1).toBe(tex2)

  const disposeSpy = vi.spyOn(tex1, 'dispose')
  releaseSignTexture(tex1)

  expect(disposeSpy).not.toHaveBeenCalled()
  expect(getSignTexture(wr, blockEntity, false)).toBe(tex1)
  expect(renderSignMock).toHaveBeenCalledTimes(1)
})

test('releaseSignTexture: dispose at zero refcount removes cache entry', () => {
  const wr = createWorldRenderer()
  const blockEntity = { Text1: '{"text":"Hello"}' }

  const tex = getSignTexture(wr, blockEntity, false)!
  const disposeSpy = vi.spyOn(tex, 'dispose')

  releaseSignTexture(tex)
  expect(disposeSpy).toHaveBeenCalledTimes(1)

  const tex2 = getSignTexture(wr, blockEntity, false)!
  expect(tex2).not.toBe(tex)
  expect(renderSignMock).toHaveBeenCalledTimes(2)
})

test('getSignTexture: key ignores irrelevant NBT fields', () => {
  const wr = createWorldRenderer()
  const base = { Text1: '{"text":"Hello"}', Color: 'black' }

  const tex1 = getSignTexture(wr, base, false)!
  const tex2 = getSignTexture(wr, { ...base, GlowingText: 1, is_waxed: 1 }, false)!

  expect(tex2).toBe(tex1)
  expect(renderSignMock).toHaveBeenCalledTimes(1)
})

test('getSignTexture: isHanging is part of cache key', () => {
  const wr = createWorldRenderer()
  const blockEntity = { Text1: '{"text":"Hello"}' }

  const standing = getSignTexture(wr, blockEntity, false)!
  const hanging = getSignTexture(wr, blockEntity, true)!

  expect(hanging).not.toBe(standing)
  expect(renderSignMock).toHaveBeenCalledTimes(2)
})
