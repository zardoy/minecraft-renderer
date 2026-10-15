import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bundlePrepareMesherWorkers, MESHER_DIST_FILES } from './bundlePrepare'

describe('MESHER_DIST_FILES', () => {
  it('is the source of truth for lightOwnerWorker.js', () => {
    expect(MESHER_DIST_FILES).toContain('lightOwnerWorker.js')
    expect(MESHER_DIST_FILES).toContain('lightOwnerWorker.js.map')
  })

  it('copies lightOwnerWorker.js from renderer dist', async () => {
    const mesherDistDir = await mkdtemp(join(tmpdir(), 'renderer-dist-'))
    const outDir = await mkdtemp(join(tmpdir(), 'app-dist-'))
    for (const name of MESHER_DIST_FILES) {
      await writeFile(join(mesherDistDir, name), `asset:${name}`)
    }

    const copied = await bundlePrepareMesherWorkers({ cwd: outDir, mesherDistDir, outDir })
    expect(copied.some(path => path.endsWith('lightOwnerWorker.js'))).toBe(true)
    expect(await readFile(join(outDir, 'lightOwnerWorker.js'), 'utf8')).toBe('asset:lightOwnerWorker.js')
  })
})
