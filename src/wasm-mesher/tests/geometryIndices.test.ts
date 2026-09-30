import { expect, test } from 'vitest'
import { appendGeometryIndices, createGeometryIndexArray } from '../bridge/geometryIndices'

function expectSameValues(actual: ArrayLike<number>, expected: ArrayLike<number>): void {
  expect(actual.length).toBe(expected.length)
  let firstMismatch = -1
  for (let index = 0; index < expected.length; index++) {
    if (actual[index] !== expected[index]) {
      firstMismatch = index
      break
    }
  }
  expect(firstMismatch, 'First differing index; -1 means all values match').toBe(-1)
}

test('creates lossless index buffers without depending on argument count', () => {
  const cases: Array<{ input: number[]; using32Array: boolean }> = [
    { input: [], using32Array: false },
    { input: [0, 65535, 7], using32Array: false },
    { input: [0, 65536, 7], using32Array: true }
  ]

  for (const { input, using32Array } of cases) {
    const inputBefore = input.slice()
    const result = createGeometryIndexArray(input)
    expect(result).toBeInstanceOf(using32Array ? Uint32Array : Uint16Array)
    expect(Array.from(result)).toEqual(inputBefore)
    expect(input).toEqual(inputBefore)
  }

  const source = new Array<number>(1_000_000).fill(65535)
  source[0] = 0
  source[500_000] = 123
  const sourceBeforeSmall = source.slice()
  const smallValues = createGeometryIndexArray(source)
  expect(smallValues).toBeInstanceOf(Uint16Array)
  expectSameValues(smallValues, sourceBeforeSmall)
  expectSameValues(source, sourceBeforeSmall)

  source[source.length - 1] = 65536
  const sourceBeforeLarge = source.slice()
  const largeValue = createGeometryIndexArray(source)
  expect(largeValue).toBeInstanceOf(Uint32Array)
  expectSameValues(largeValue, sourceBeforeLarge)
  expectSameValues(source, sourceBeforeLarge)
})

test('appends large liquid indices before rebased block indices', () => {
  const liquidIndices = new Array<number>(1_000_000).fill(0)
  liquidIndices[0] = 2
  liquidIndices[liquidIndices.length - 1] = 1
  const blockBlendIndices = [0, 2, 1]
  const liquidVertexCount = 3
  const blendIndices: number[] = []
  const liquidIndicesBefore = liquidIndices.slice()
  const blockBlendIndicesBefore = blockBlendIndices.slice()

  appendGeometryIndices(blendIndices, liquidIndices, 0)
  appendGeometryIndices(blendIndices, blockBlendIndices, liquidVertexCount)

  expect(blendIndices.length).toBe(liquidIndicesBefore.length + blockBlendIndicesBefore.length)
  expectSameValues(blendIndices.slice(0, liquidIndicesBefore.length), liquidIndicesBefore)
  expect(blendIndices.slice(liquidIndicesBefore.length)).toEqual([3, 5, 4])
  expect(blockBlendIndices).toEqual(blockBlendIndicesBefore)
  expectSameValues(liquidIndices, liquidIndicesBefore)

  const snapshot = blendIndices.slice()
  appendGeometryIndices(blendIndices, [], liquidVertexCount)
  expectSameValues(blendIndices, snapshot)
})
