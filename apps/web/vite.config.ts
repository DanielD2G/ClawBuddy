import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 4321,
    host: true,
    allowedHosts: ['mac.tail200d4b.ts.net'],
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
})
