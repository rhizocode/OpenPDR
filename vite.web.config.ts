import { defineConfig } from 'vite'
import pkg from './package.json'

export default defineConfig({
  root: 'src/web',
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: '../../dist-web',
    emptyOutDir: true,
  },
})
