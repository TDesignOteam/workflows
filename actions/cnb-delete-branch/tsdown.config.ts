import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['index.ts'],
  deps: {
    alwaysBundle: ['@actions/core'],
    onlyBundle: [
      '@actions/core',
      '@actions/exec',
      '@actions/http-client',
      '@actions/io',
      'tunnel',
      'undici',
    ],
  },
})
