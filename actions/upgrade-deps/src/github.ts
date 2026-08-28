import type { DependencyInfo, DependencyRelease, GithubRepository } from './types'
import { readFile } from 'node:fs/promises'
import * as core from '@actions/core'
import { PR_TEMPLATE_PATHS } from './constants'

export function parseGithubRepository(repositoryUrl?: string): GithubRepository | undefined {
  if (!repositoryUrl)
    return undefined
  const normalized = repositoryUrl.replace(/^git\+/, '').replace(/^git@github\.com:/, 'https://github.com/').replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/').replace(/^git:\/\/github\.com\//, 'https://github.com/')
  try {
    const url = new URL(normalized)
    if (url.hostname !== 'github.com')
      return undefined
    const [owner, name] = url.pathname.replace(/^\//, '').split('/')
    const repo = name?.replace(/\.git$/, '')
    return owner && repo ? { owner, repo } : undefined
  }
  catch {
    return undefined
  }
}

function getMarkdownHeading(line: string): string | undefined {
  const prefix = line.match(/^#{1,6}[ \t]+/)
  return prefix ? line.slice(prefix[0].length).trim() : undefined
}

export function extractVersionChangelog(content: string, version: string): string | undefined {
  const pattern = new RegExp(`(?:^|[^0-9a-z])v?${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^0-9a-z])`, 'i')
  const lines = content.split('\n')
  const start = lines.findIndex((line) => {
    const heading = getMarkdownHeading(line)
    return heading !== undefined && pattern.test(heading.replace(/\]\([^)]*\)/g, ']'))
  })
  if (start === -1)
    return undefined
  const level = lines[start].match(/^#+/)?.[0].length
  if (!level)
    return undefined
  const end = lines.findIndex((line, index) => index > start && (line.match(/^#{1,6}(?=[ \t])/)?.[0].length ?? 7) <= level)
  return lines.slice(start, end === -1 ? undefined : end).join('\n').trim()
}

export async function fetchDependencyRelease(dep: DependencyInfo, token: string): Promise<DependencyRelease | undefined> {
  const repository = parseGithubRepository(dep.repositoryUrl)
  if (!repository) {
    core.warning(`No GitHub repository found for ${dep.name}; skipping changelog`)
    return undefined
  }
  const headers: Record<string, string> = { 'Accept': 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' }
  if (token && token !== 'test')
    headers.Authorization = `Bearer ${token}`
  try {
    const changelogPath = [...(dep.repositoryDirectory?.split('/').filter(Boolean) ?? []), 'CHANGELOG.md'].map(encodeURIComponent).join('/')
    const response = await fetch(`https://api.github.com/repos/${repository.owner}/${repository.repo}/contents/${changelogPath}`, { headers })
    if (response.status === 404) {
      core.warning(`No CHANGELOG.md found for ${dep.name}`)
      return undefined
    }
    if (!response.ok)
      throw new Error(`status code: ${response.status}`)
    const body = extractVersionChangelog(await response.text(), dep.version)
    if (!body) {
      core.warning(`No ${dep.version} entry found in CHANGELOG.md for ${dep.name}`)
      return undefined
    }
    const url = `https://github.com/${repository.owner}/${repository.repo}/blob/HEAD/${changelogPath}`
    return { body, tag: `${dep.name}@${dep.version}`, url }
  }
  catch (error) {
    core.warning(`Failed to get CHANGELOG.md for ${dep.name}@${dep.version}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

export function resolveDependencyReleases(deps: DependencyInfo[], token: string): Promise<DependencyInfo[]> {
  return Promise.all(deps.map(async dep => ({ ...dep, release: await fetchDependencyRelease(dep, token) })))
}

export async function readPullRequestTemplate(repoPath: string): Promise<string | undefined> {
  for (const templatePath of PR_TEMPLATE_PATHS) {
    try {
      return await readFile(`${repoPath}/${templatePath}`, 'utf8')
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error
    }
  }
  return undefined
}
