import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import { BASE } from './src/constants'

export default defineConfig({
  base: BASE,
  plugins: [solid()],
  build: {
    target: 'esnext',
  },
  worker: {
    format: 'es',
    plugins: () => [solid()],
  },
})
