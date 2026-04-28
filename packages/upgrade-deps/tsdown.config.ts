import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['index.ts'],
  shims: true,
  deps: {
    alwaysBundle: [
      '@actions/core',
      '@actions/exec',
      '@actions/github',
      '@workflows/utils'
    ],
    onlyBundle: [
      '@actions/core',
      '@actions/exec',
      '@actions/github',
      '@actions/http-client',
      '@actions/io',
      '@octokit/auth-token',
      '@octokit/core',
      '@octokit/endpoint',
      '@octokit/graphql',
      '@octokit/plugin-paginate-rest',
      '@octokit/plugin-rest-endpoint-methods',
      '@octokit/request',
      '@octokit/request-error',
      'before-after-hook',
      'fast-content-type-parse',
      'tunnel',
      'undici',
      'universal-user-agent',
    ],
  },
})
