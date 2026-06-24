import type { PerformanceInstabilityFactors } from './types'

const FACTOR_CODES: Array<{ key: keyof PerformanceInstabilityFactors; code: string }> = [
  { key: 'longRenderTime', code: 'LR' },
  { key: 'constantLongRenderTime', code: 'CLR' },
  { key: 'tooManyEntities', code: 'ENT' },
  { key: 'tooManyTextures', code: 'TEX' },
  { key: 'unknownReason', code: 'UNK' }
]

/** Compact debug overlay fragment, e.g. `LR+ENT` or empty string. */
export function formatPerformanceFactorsDebug(factors: PerformanceInstabilityFactors): string {
  const active = FACTOR_CODES.filter(({ key }) => factors[key]).map(({ code }) => code)
  return active.length > 0 ? active.join('+') : ''
}
