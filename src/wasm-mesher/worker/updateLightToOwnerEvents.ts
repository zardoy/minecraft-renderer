import { maskBitGet, parsedUpdateLightFromWasm, type ParsedUpdateLight } from './mesherWasmLightMerge'
import { packUnpackedLightSection } from '../../mesher-shared/lightNibblePack'
import type { LightOwnerEvent } from '../../three/lightOwnerHost'

export function eventsFromParsedUpdateLight(parsed: ParsedUpdateLight, worldMinY: number): LightOwnerEvent[] {
  const sx = parsed.x
  const sz = parsed.z
  const baseSy = Math.floor(worldMinY / 16)
  const events: LightOwnerEvent[] = []
  const pushChannel = (channel: 'block' | 'sky', dataMask: Uint32Array, emptyMask: Uint32Array, column: Uint8Array, below?: Uint8Array, above?: Uint8Array) => {
    const totalBits = parsed.numSections + 2
    for (let bit = 0; bit < totalBits; bit++) {
      const hasData = maskBitGet(dataMask, bit)
      const hasEmpty = maskBitGet(emptyMask, bit)
      if (!hasData && !hasEmpty) continue
      const sy = baseSy + bit - 1
      if (hasEmpty) {
        events.push({ type: 'serverLight', sx, sy, sz, channel, kind: 'empty' })
        continue
      }
      let unpacked: Uint8Array | undefined
      if (bit === 0) unpacked = below
      else if (bit === parsed.numSections + 1) unpacked = above
      else unpacked = column.subarray((bit - 1) * 4096, bit * 4096)
      if (!unpacked || unpacked.length < 4096) {
        events.push({ type: 'serverLight', sx, sy, sz, channel, kind: 'empty' })
        continue
      }
      events.push({
        type: 'serverLight',
        sx,
        sy,
        sz,
        channel,
        kind: 'data',
        data: packUnpackedLightSection(unpacked)
      })
    }
  }
  pushChannel('block', parsed.blockLightMask, parsed.emptyBlockLightMask, parsed.blockLight, parsed.blockBelow, parsed.blockAbove)
  pushChannel('sky', parsed.skyLightMask, parsed.emptySkyLightMask, parsed.skyLight, parsed.skyBelow, parsed.skyAbove)
  return events
}

export function eventsFromWasmUpdateLight(parsedJs: unknown, numSections: number, worldMinY: number): LightOwnerEvent[] {
  return eventsFromParsedUpdateLight(parsedUpdateLightFromWasm(parsedJs, numSections), worldMinY)
}
