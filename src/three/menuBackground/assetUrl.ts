export function menuBackgroundAssetUrl(...segments: string[]): string {
  const relative = segments.filter(s => s.length > 0).join('/')
  const base =
    typeof globalThis.location !== 'undefined' && globalThis.location.href
      ? globalThis.location.href
      : typeof import.meta !== 'undefined' && import.meta.url
        ? import.meta.url
        : `/${relative}`
  try {
    return new URL(relative, base).href
  } catch {
    return `/${relative}`
  }
}
