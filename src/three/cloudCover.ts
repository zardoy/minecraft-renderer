import type { CloudCover } from './cloudGeometry'

/** Texels at least this opaque count as cloud. */
const ALPHA_THRESHOLD = 128

/** Decodes vanilla clouds.png into a per-cell mask (works on the main thread and in workers). */
export async function loadCloudCover(url: string): Promise<CloudCover> {
  const blob = await (await fetch(url)).blob()
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none' })
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    const filled = new Uint8Array(bitmap.width * bitmap.height)
    for (let i = 0; i < filled.length; i++) filled[i] = data[i * 4 + 3] >= ALPHA_THRESHOLD ? 1 : 0
    return { width: bitmap.width, height: bitmap.height, filled }
  } finally {
    bitmap.close()
  }
}
