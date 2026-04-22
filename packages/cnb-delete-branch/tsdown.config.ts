import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['index.ts'],
  deps: {
    alwaysBundle: ['@actions/core', 'node-cnb'],
    onlyBundle: [
      '@actions/core',
      '@actions/exec',
      '@actions/http-client',
      '@actions/io',
      'ky',
      'node-cnb',
      'tunnel',
      'undici',
    ],
  },
})
