import { cp, mkdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

/** Worker-related basenames inside `minecraft-renderer`/`dist`; skipped if missing. */
export const MESHER_DIST_FILES = [
  'mesher.js',
  'mesher.js.map',
  'mesherWasm.js',
  'mesherWasm.js.map',
] as const

export type BundlePrepareMesherOptions = {
  cwd?: string
  packageName?: string
  outDir?: string
  mesherDistDir?: string
  files?: readonly string[]
}

function resolveSrcDist (opts: BundlePrepareMesherOptions | undefined, cwd: string): string {
  if (opts?.mesherDistDir) return path.resolve(cwd, opts.mesherDistDir)
  const pkg = opts?.packageName ?? 'minecraft-renderer'
  const req = createRequire(path.join(cwd, 'package.json'))
  return path.join(path.dirname(req.resolve(`${pkg}/package.json`)), 'dist')
}

export async function bundlePrepareMesherWorkers (opts?: BundlePrepareMesherOptions): Promise<string[]> {
  const cwd = opts?.cwd ?? process.cwd()
  const outDir = path.resolve(cwd, opts?.outDir ?? 'dist')
  const srcDist = resolveSrcDist(opts, cwd)
  const names = opts?.files ?? MESHER_DIST_FILES

  await stat(srcDist).catch(() => {
    throw new Error(`[bundlePrepareMesherWorkers] missing dist: ${srcDist}`)
  })
  await mkdir(outDir, { recursive: true })

  const copied: string[] = []
  for (const name of names) {
    const from = path.join(srcDist, name)
    let st
    try {
      st = await stat(from)
    } catch {
      continue
    }
    if (!st.isFile()) continue
    const to = path.join(outDir, name)
    await mkdir(path.dirname(to), { recursive: true })
    await cp(from, to)
    copied.push(path.relative(process.cwd(), to) || to)
  }
  return copied
}
