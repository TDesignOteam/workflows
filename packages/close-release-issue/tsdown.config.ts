import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['index.ts'],
  noExternal: ['@actions/core'],
  inlineOnly: false,
})
