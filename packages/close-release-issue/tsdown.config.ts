import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['index.ts'],
  noExternal: ['@actions/core', '@actions/github'],
  inlineOnly: false,
})
