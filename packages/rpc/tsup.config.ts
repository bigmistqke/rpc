import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    messenger: 'src/messenger/index.ts',
    websocket: 'src/websocket/index.ts',
    stream: 'src/stream/index.ts',
    fetch: 'src/fetch/index.ts',
    'fetch-node': 'src/fetch/node.ts',
  },
  format: ['esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: 'esnext',
  noExternal: ['valibot'],
})
