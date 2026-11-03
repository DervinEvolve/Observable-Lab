import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,  // Vite's default - vercel dev will proxy to this
    watch: {
      ignored: ['**/vercel-api/**', '**/vercel-server/**', '**/api/**']
    }
  },
  preview: { host: '127.0.0.1' },
  build: {
    target: 'esnext',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html')
      }
    }
  }
})

