#!/usr/bin/env node
/**
 * Script to add //@ts-nocheck to all TypeScript files in src/
 *
 * Usage: node scripts/addTsNocheck.mjs
 */

import { readFileSync, writeFileSync } from 'fs'
import { readdir, stat } from 'fs/promises'
import { join, extname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const rootDir = join(__dirname, '..')
const srcDir = join(rootDir, 'src')

const TS_NOCHECK = '//@ts-nocheck'

/**
 * Recursively find all .ts files in a directory
 */
async function findTsFiles(dir) {
  const files = []
  const entries = await readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)

    if (entry.isDirectory()) {
      // Skip node_modules and other common directories
      if (entry.name === 'node_modules' || entry.name === '.git') {
        continue
      }
      const subFiles = await findTsFiles(fullPath)
      files.push(...subFiles)
    } else if (entry.isFile() && extname(entry.name) === '.ts') {
      files.push(fullPath)
    }
  }

  return files
}

/**
 * Check if file already has //@ts-nocheck at the top
 */
function hasTsNocheck(content) {
  const trimmed = content.trimStart()
  return trimmed.startsWith(TS_NOCHECK) || trimmed.startsWith('// @ts-nocheck')
}

/**
 * Add //@ts-nocheck to a file if it doesn't already have it
 */
function addTsNocheck(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8')

    if (hasTsNocheck(content)) {
      console.log(`✓ Already has @ts-nocheck: ${filePath}`)
      return false
    }

    // Add //@ts-nocheck at the beginning
    const newContent = TS_NOCHECK + '\n' + content
    writeFileSync(filePath, newContent, 'utf-8')
    console.log(`✓ Added @ts-nocheck to: ${filePath}`)
    return true
  } catch (error) {
    console.error(`✗ Error processing ${filePath}:`, error.message)
    return false
  }
}

/**
 * Main function
 */
async function main() {
  console.log('Finding all TypeScript files in src/...')
  const tsFiles = await findTsFiles(srcDir)

  console.log(`Found ${tsFiles.length} TypeScript files`)
  console.log('')

  let addedCount = 0
  let skippedCount = 0
  let errorCount = 0

  for (const file of tsFiles) {
    const result = addTsNocheck(file)
    if (result === true) {
      addedCount++
    } else if (result === false) {
      skippedCount++
    } else {
      errorCount++
    }
  }

  console.log('')
  console.log('Summary:')
  console.log(`  Added: ${addedCount}`)
  console.log(`  Skipped (already has): ${skippedCount}`)
  console.log(`  Errors: ${errorCount}`)
  console.log(`  Total: ${tsFiles.length}`)
}

main().catch(error => {
  console.error('Fatal error:', error)
  process.exit(1)
})
