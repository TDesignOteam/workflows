import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['index.ts'],
  deps: {
    neverBundle: ['undici', 'tunnel'],
  },
})
