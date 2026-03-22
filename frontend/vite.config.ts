import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { mkdir, writeFile } from 'fs/promises'

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:4000'
const buildInfo = {
  version: process.env.VITE_CLAWBUDDY_VERSION ?? 'dev',
  commitSha: process.env.VITE_CLAWBUDDY_COMMIT_SHA ?? 'local',
  builtAt: process.env.VITE_CLAWBUDDY_BUILD_TIME ?? '',
}

const versionManifestPlugin = {
  name: 'clawbuddy-version-manifest',
  apply: 'build' as const,
  async writeBundle(options: { dir?: string }) {
    const outDir = options.dir
      ? path.resolve(__dirname, options.dir)
      : path.resolve(__dirname, 'dist')
    await mkdir(outDir, { recursive: true })
    await writeFile(path.join(outDir, 'version.json'), JSON.stringify(buildInfo, null, 2))
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss(), versionManifestPlugin],
  define: {
    __CLAWBUDDY_BUILD_INFO__: JSON.stringify(buildInfo),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 4321,
    host: true,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
})
