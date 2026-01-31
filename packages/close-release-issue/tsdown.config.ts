import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['index.ts'],
  noExternal: ['@actions/core', '@actions/github', '@workflows/utils'],
  inlineOnly: [
    '@actions/core',
    '@actions/http-client',
    'tunnel',
    'undici',
    '@fastify/busboy',
    '@actions/io',
    '@actions/exec',
    '@actions/github',
    'universal-user-agent',
    'before-after-hook',
    '@octokit/endpoint',
    'deprecation',
    'wrappy',
    'once',
    '@octokit/request-error',
    '@octokit/request',
    '@octokit/graphql',
    '@octokit/auth-token',
    '@octokit/core',
    '@octokit/plugin-rest-endpoint-methods',
    '@octokit/plugin-paginate-rest',
  ],
})
