import { defineConfig, ModifyRspackConfigUtils } from '@rsbuild/core'
import { pluginNodePolyfill } from '@rsbuild/plugin-node-polyfill'
import { pluginReact } from '@rsbuild/plugin-react'
import path from 'path'
import fs from 'fs'

const dev = process.env.NODE_ENV === 'development'

const PLAYGROUND_VERSION = '1.16.5'

export default defineConfig({
  html: {
    template: './src/playground/playground.html'
  },
  output: {
    polyfill: 'usage',
    assetPrefix: './',
    distPath: {
      root: './dist'
    }
  },
  source: {
    entry: {
      index: './src/playground/playground.ts'
    },
    alias: {
      '@': path.resolve(__dirname, './src'),
      three$: 'three/src/Three.js',
      'stats.js$': 'stats.js/src/Stats.js'
    },
    define: {
      'process.platform': '"browser"',
      'process.env.BROWSER': '"true"',
      'globalThis.includedVersions': JSON.stringify([PLAYGROUND_VERSION])
    }
  },
  dev: {
    progressBar: true,
    writeToDisk: true,
    watchFiles: [
      {
        paths: ['dist/mesher.js']
      }
    ]
  },
  server: {
    port: 3001,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  },
  plugins: [
    pluginReact(),
    pluginNodePolyfill(),
    {
      name: 'minecraft-data-patch',
      setup(api) {
        api.modifyRspackConfig((config, { appendPlugins, addRules, rspack }) => {
          // Add rules for .obj and other file types
          addRules([
            {
              test: /\.obj$/,
              type: 'asset/source'
            },
            {
              test: /\.wgsl$/,
              type: 'asset/source'
            }
          ])

          // Replace minecraft-data/data.js with a minimal version
          appendPlugins(
            new rspack.NormalModuleReplacementPlugin(/data/, resource => {
              const request = resource.request.replaceAll('\\', '/')
              const absolute = path.join(resource.context, request).replaceAll('\\', '/')

              if (absolute.endsWith('/minecraft-data/data.js')) {
                resource.request = path.join(__dirname, './src/shims/minecraftData.ts')
              }
            })
          )

          config.ignoreWarnings = [/the request of a dependency is an expression/]
        })
      }
    },
    {
      name: 'copy-entity-textures',
      setup(api) {
        api.onBeforeStartDevServer(async () => {
          const entityTexturesPath = './node_modules/mc-assets/dist/other-textures/latest/entity'
          const destPath = './dist/playground/textures/entity'
          if (fs.existsSync(entityTexturesPath)) {
            fs.mkdirSync(destPath, { recursive: true })
            // Simple recursive copy
            const copyRecursive = (src: string, dest: string) => {
              if (fs.statSync(src).isDirectory()) {
                fs.mkdirSync(dest, { recursive: true })
                for (const file of fs.readdirSync(src)) {
                  copyRecursive(path.join(src, file), path.join(dest, file))
                }
              } else {
                fs.copyFileSync(src, dest)
              }
            }
            copyRecursive(entityTexturesPath, destPath)
          }
        })
      }
    }
  ]
})
