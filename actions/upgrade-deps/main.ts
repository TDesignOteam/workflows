import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import { GitHelper, GithubHelper } from '@workflows/utils'

interface TriggerContext {
  repo: string
  owner: string
  token: string
  dryRun: boolean
  trigger: string
}

export interface DependencyInfo {
  name: string
  version: string
  repositoryUrl?: string
  release?: DependencyRelease
}

export interface DependencyRelease {
  body: string
  tag: string
  url: string
}

export interface GithubRepository {
  owner: string
  repo: string
}

const PACKAGE_MANAGER_COMMANDS = {
  pnpm: { cmd: 'pnpm', args: ['-r', 'up', '--latest'] },
  yarn: { cmd: 'yarn', args: ['upgrade', '--latest'] },
  npm: { cmd: 'npm', args: ['install'] },
} as const

const PR_TEMPLATE_PATHS = [
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md',
  'pull_request_template.md',
  'docs/PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
]

const COMPONENT_REPOSITORIES = new Set([
  'tdesign-flutter',
  'tdesign-miniprogram',
  'tdesign-mobile-react',
  'tdesign-mobile-vue',
  'tdesign-react',
  'tdesign-vue',
  'tdesign-vue-next',
])

const CHANGELOG_TARGET_SECTIONS: Record<string, string[]> = {
  'tdesign-miniprogram': ['tdesign-miniprogram', '@tdesign/uniapp'],
  'tdesign-react': ['tdesign-react'],
  'tdesign-vue-next': ['tdesign-vue-next'],
}

type PackageManager = keyof typeof PACKAGE_MANAGER_COMMANDS

function slugify(value: string): string {
  return value.replace(/@/g, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
}

export function getBranchName(deps: DependencyInfo[]): string {
  const depsSlug = deps.map(d => `${slugify(d.name)}-${slugify(d.version)}`).join('-')
  return `chore/deps/upgrade-${depsSlug}`
}

export function getPrTitle(deps: DependencyInfo[]): string {
  const depList = deps.map(d => `${d.name} to ${d.version}`).join(', ')
  return `chore: upgrade ${depList}`
}

export function getRepoPath(repo: string, targetDir: string): string {
  const base = `./${repo}`
  return targetDir ? path.join(base, targetDir) : base
}

export function parseDependencyName(spec: string): string {
  const value = spec.trim()
  if (!value)
    throw new Error('Empty dependency name')

  const versionSeparator = value.startsWith('@')
    ? value.indexOf('@', value.indexOf('/') + 1)
    : value.lastIndexOf('@')

  if (versionSeparator > 0)
    throw new Error(`Dependency versions are not supported: ${spec}. Please pass package names only.`)

  return value
}

export function parseDependencyInputs(inputs: string[]): string[] {
  const deps = inputs
    .flatMap(input => input.split(/\s+/))
    .map(item => item.trim())
    .filter(Boolean)
    .map(parseDependencyName)

  if (!deps.length)
    throw new Error('Missing deps input')

  return deps
}

export function validatePackageManager(packageManager: string): PackageManager {
  if (packageManager in PACKAGE_MANAGER_COMMANDS)
    return packageManager as PackageManager

  throw new Error(`Unsupported package-manager "${packageManager}". Supported values: npm, yarn, pnpm.`)
}

export function parseGithubRepository(repositoryUrl?: string): GithubRepository | undefined {
  if (!repositoryUrl)
    return undefined

  const normalizedUrl = repositoryUrl
    .replace(/^git\+/, '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
    .replace(/^git:\/\/github\.com\//, 'https://github.com/')

  try {
    const url = new URL(normalizedUrl)
    if (url.hostname !== 'github.com')
      return undefined

    const [owner, repoName] = url.pathname.replace(/^\//, '').split('/')
    const repo = repoName?.replace(/\.git$/, '')
    return owner && repo ? { owner, repo } : undefined
  }
  catch {
    return undefined
  }
}

export async function fetchPackageVersion(pkg: string): Promise<DependencyInfo> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${pkg}/latest`)
    if (!response.ok) {
      throw new Error(`status code: ${response.status}`)
    }
    const { version, repository } = await response.json() as {
      repository?: string | { url?: string }
      version?: string
    }
    if (!version) {
      throw new Error('no version found')
    }
    core.info(`Latest version of ${pkg} is ${version}`)
    const repositoryUrl = typeof repository === 'string' ? repository : repository?.url
    return { name: pkg, version, ...(repositoryUrl ? { repositoryUrl } : {}) }
  }
  catch (error) {
    throw new Error(`Failed to get ${pkg} info from npm registry: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function resolveDependencyInfos(deps: string[]): Promise<DependencyInfo[]> {
  return Promise.all(deps.map(fetchPackageVersion))
}

function getReleaseTags(dep: DependencyInfo): string[] {
  return [...new Set([
    `${dep.name}@${dep.version}`,
    dep.version,
    `v${dep.version}`,
  ])]
}

export async function fetchDependencyRelease(dep: DependencyInfo, token: string): Promise<DependencyRelease | undefined> {
  const repository = parseGithubRepository(dep.repositoryUrl)
  if (!repository) {
    core.warning(`No GitHub repository found for ${dep.name}; skipping release notes`)
    return undefined
  }

  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token && token !== 'test') {
    headers.Authorization = `Bearer ${token}`
  }

  try {
    for (const tag of getReleaseTags(dep)) {
      const response = await fetch(
        `https://api.github.com/repos/${repository.owner}/${repository.repo}/releases/tags/${encodeURIComponent(tag)}`,
        { headers },
      )
      if (response.status === 404)
        continue
      if (!response.ok)
        throw new Error(`status code: ${response.status}`)

      const release = await response.json() as { body?: string | null, html_url?: string }
      if (!release.html_url)
        throw new Error('release URL not found')

      core.info(`Release notes found for ${dep.name}@${dep.version}: ${release.html_url}`)
      return {
        body: release.body?.trim() || 'No release notes provided.',
        tag,
        url: release.html_url,
      }
    }
  }
  catch (error) {
    core.warning(`Failed to get release notes for ${dep.name}@${dep.version}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }

  core.warning(`No GitHub release found for ${dep.name}@${dep.version}`)
  return undefined
}

export async function resolveDependencyReleases(deps: DependencyInfo[], token: string): Promise<DependencyInfo[]> {
  return Promise.all(deps.map(async dep => ({
    ...dep,
    release: await fetchDependencyRelease(dep, token),
  })))
}

export async function updatePackageDependencies(packageManager: PackageManager, deps: string[], repo: string, targetDir: string): Promise<void> {
  const repoPath = getRepoPath(repo, targetDir)
  const { cmd, args } = PACKAGE_MANAGER_COMMANDS[packageManager]
  await exec.exec(cmd, [...args, ...deps], { cwd: repoPath })
}

export async function readPullRequestTemplate(repoPath: string): Promise<string | undefined> {
  for (const templatePath of PR_TEMPLATE_PATHS) {
    try {
      return await readFile(path.join(repoPath, templatePath), 'utf8')
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error
    }
  }
  return undefined
}

function getMarkdownHeading(line: string): string | undefined {
  const prefix = line.match(/^#{1,6}[ \t]+/)
  return prefix ? line.slice(prefix[0].length).trim() : undefined
}

function insertAfterHeading(body: string, headingPattern: RegExp, content: string): { body: string, inserted: boolean } {
  const lines = body.split('\n')
  const headingIndex = lines.findIndex((line) => {
    const heading = getMarkdownHeading(line)
    return heading !== undefined && headingPattern.test(heading)
  })
  if (headingIndex === -1)
    return { body, inserted: false }

  lines.splice(headingIndex + 1, 0, '', content)
  return { body: lines.join('\n'), inserted: true }
}

function insertAfterExactHeading(body: string, heading: string, content: string): { body: string, inserted: boolean } {
  const lines = body.split('\n')
  const headingIndex = lines.findIndex(line => getMarkdownHeading(line) === heading)
  if (headingIndex === -1)
    return { body, inserted: false }

  lines.splice(headingIndex + 1, 0, '', content)
  return { body: lines.join('\n'), inserted: true }
}

function formatReleaseBody(body: string): string {
  return body
    .trim()
    .replace(/^(#{1,6})(?=\s)/gm, heading => '#'.repeat(Math.min(6, heading.length + 3)))
}

export function getDependencySummary(deps: DependencyInfo[]): string {
  return [
    '自动升级以下依赖：',
    '',
    ...deps.map(dep => `- \`${dep.name}\` 升级至 \`${dep.version}\``),
  ].join('\n')
}

export function getReleaseNotesMarkdown(deps: DependencyInfo[]): string {
  return deps.map((dep) => {
    const npmUrl = `https://www.npmjs.com/package/${dep.name}/v/${dep.version}`
    if (!dep.release) {
      return `#### [\`${dep.name}@${dep.version}\`](${npmUrl})\n\n未找到对应的 GitHub Release Notes。`
    }

    return `#### [\`${dep.name}@${dep.version}\`](${dep.release.url})\n\n${formatReleaseBody(dep.release.body)}`
  }).join('\n\n')
}

type ChangelogType = 'build' | 'chore' | 'ci' | 'docs' | 'feat' | 'feat!' | 'fix' | 'perf' | 'refactor' | 'style' | 'test'

interface ChangelogEntry {
  text: string
  type: ChangelogType
}

function getChangelogType(heading: string): ChangelogType | undefined {
  const value = heading.toLowerCase()
  if (/breaking changes?|破坏性/.test(value))
    return 'feat!'
  if (/bug fixes?|fixes|修复/.test(value))
    return 'fix'
  if (/features?|新特性|新增功能/.test(value))
    return 'feat'
  if (/performance|性能/.test(value))
    return 'perf'
  if (/documentation|\bdocs?\b|文档/.test(value))
    return 'docs'
  if (/refactor|重构/.test(value))
    return 'refactor'
  if (/tests?|测试/.test(value))
    return 'test'
  if (/\bci\b|持续集成/.test(value))
    return 'ci'
  if (/build|构建/.test(value))
    return 'build'
  if (/styles?|代码风格/.test(value))
    return 'style'
  if (/others?|其他/.test(value))
    return 'chore'
  return undefined
}

export function parseReleaseChangelog(body: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  const parents: Array<{ indent: number, text: string }> = []
  let currentType: ChangelogType | undefined

  for (const line of body.split('\n')) {
    const heading = getMarkdownHeading(line)
    if (heading !== undefined) {
      currentType = getChangelogType(heading)
      parents.length = 0
      continue
    }

    const bulletPrefix = line.match(/^([ \t]*)[-*+][ \t]+/)
    if (!bulletPrefix || !currentType)
      continue

    const indent = bulletPrefix[1].replace(/\t/g, '  ').length
    const text = line.slice(bulletPrefix[0].length).trim()
    if (!text)
      continue

    while (parents.length && parents[parents.length - 1].indent >= indent) {
      parents.pop()
    }

    if (text.endsWith(':')) {
      parents.push({ indent, text: text.slice(0, -1) })
      continue
    }

    const parentText = parents.map(parent => parent.text).join(': ')
    entries.push({
      text: parentText ? `${parentText}: ${text}` : text,
      type: currentType,
    })
  }

  return entries
}

function formatChangelogType(type: ChangelogType, scoped: boolean): string {
  const breaking = type.endsWith('!')
  const baseType = breaking ? type.slice(0, -1) : type
  return `${baseType}${scoped ? '(Icon)' : ''}${breaking ? '!' : ''}`
}

export function getChangelogMarkdown(deps: DependencyInfo[], targetRepo: string): string {
  const scoped = COMPONENT_REPOSITORIES.has(targetRepo)
  return deps.flatMap((dep) => {
    const entries = dep.release ? parseReleaseChangelog(dep.release.body) : []
    if (!entries.length) {
      return [`- ${formatChangelogType('chore', scoped)}: upgrade ${dep.name} to ${dep.version}`]
    }
    return entries.map(entry => `- ${formatChangelogType(entry.type, scoped)}: ${entry.text}`)
  }).join('\n')
}

function fillTDesignCheckboxes(template: string): string {
  const checkedLabels = [
    '其他',
    '文档已补充或无须补充',
    '代码演示已提供或无须提供',
    'TypeScript 定义已补充或无须补充',
    'Changelog 已提供或无须提供',
  ]

  return template
    .replace(/^- \[ \] (.+)$/gm, (line, label: string) => (
      checkedLabels.includes(label.trim()) ? line.replace('[ ]', '[x]') : line
    ))
    .replace(/^- fix\(组件名称\): 处理问题或特性描述 \.\.\.$/gm, '')
}

function insertChangelog(body: string, targetRepo: string, changelog: string): { body: string, inserted: boolean } {
  const targetSections = CHANGELOG_TARGET_SECTIONS[targetRepo] ?? []
  let result = body
  let inserted = false
  for (const section of targetSections) {
    const sectionResult = insertAfterExactHeading(result, section, changelog)
    result = sectionResult.body
    inserted ||= sectionResult.inserted
  }

  if (inserted)
    return { body: result, inserted }
  return insertAfterHeading(result, /更新日志|changelog|release notes/i, changelog)
}

export function buildPullRequestBody(template: string | undefined, deps: DependencyInfo[], targetRepo: string): string {
  const summary = getDependencySummary(deps)
  const releaseNotes = getReleaseNotesMarkdown(deps)
  const background = `${summary}\n\n${releaseNotes}`
  const changelog = getChangelogMarkdown(deps, targetRepo)
  if (!template) {
    return `## 依赖升级\n\n${background}\n\n## 版本日志\n\n${changelog}`
  }

  let body = fillTDesignCheckboxes(template.trim())
  const issueResult = insertAfterHeading(body, /相关 Issue|related issues?/i, '无')
  body = issueResult.body
  const backgroundResult = insertAfterHeading(body, /需求背景|解决方案|background|summary|description/i, background)
  body = backgroundResult.body
  const changelogResult = insertChangelog(body, targetRepo, changelog)
  body = changelogResult.body

  const fallbackSections = [
    !backgroundResult.inserted ? `## 依赖升级\n\n${background}` : '',
    !changelogResult.inserted ? `## 版本日志\n\n${changelog}` : '',
  ].filter(Boolean)

  return fallbackSections.length ? `${fallbackSections.join('\n\n')}\n\n${body}` : body
}

async function createDepsPr(
  title: string,
  body: string,
  branchName: string,
  baseBranch: string,
  context: TriggerContext,
): Promise<void> {
  const githubHelper = new GithubHelper({
    owner: context.owner,
    repo: context.repo,
    token: context.token,
    dryRun: context.dryRun,
  })
  await githubHelper.createPR(title, branchName, body, baseBranch)
}

export async function updateDependencies(context: TriggerContext): Promise<void> {
  const packageManager = validatePackageManager(core.getInput('package-manager') || 'npm')
  const targetDir = core.getInput('target-dir') || ''
  const customTitle = core.getInput('title') || ''
  const deps = parseDependencyInputs(core.getMultilineInput('deps', { required: true, trimWhitespace: true }))

  core.info(`deps: ${JSON.stringify(deps)}`)
  core.info(`target-dir: ${targetDir || 'default (repo root)'}`)
  if (customTitle) {
    core.info(`custom-title: ${customTitle}`)
  }

  let depInfos = await resolveDependencyInfos(deps)
  core.info(`depInfos: ${JSON.stringify(depInfos)}`)

  if (packageManager !== 'npm') {
    await exec.exec('corepack', ['enable'])
  }

  const gitHelper = new GitHelper({
    repo: context.repo,
    owner: context.owner,
    token: context.token,
    dryRun: context.dryRun,
  })

  const baseBranch = await gitHelper.clone()
  await gitHelper.initSubmodule()
  const pullRequestTemplate = await readPullRequestTemplate(getRepoPath(context.repo, ''))
  depInfos = await resolveDependencyReleases(depInfos, context.token)
  const branchName = getBranchName(depInfos)
  await gitHelper.createBranch(branchName)

  await updatePackageDependencies(packageManager, deps, context.repo, targetDir)

  if (!(await gitHelper.isNeedCommit())) {
    core.info('No changes to commit')
    return
  }

  core.startGroup('Changes to commit')
  await gitHelper.printDiff()
  core.endGroup()

  const title = customTitle || getPrTitle(depInfos)
  const body = buildPullRequestBody(pullRequestTemplate, depInfos, context.repo)
  await gitHelper.commit(title)
  await gitHelper.push(branchName)
  await createDepsPr(title, body, branchName, baseBranch, context)
}

export async function main(): Promise<void> {
  const repo = core.getInput('repo') || github.context.repo.repo
  const owner = core.getInput('owner') || github.context.repo.owner
  const token = core.getInput('token', { required: true })
  const dryRun = core.getBooleanInput('dry-run')

  core.startGroup('upgrade-deps')
  core.info(`repo: ${repo}`)
  core.info(`owner: ${owner}`)
  core.endGroup()

  await updateDependencies({
    repo,
    owner,
    token,
    dryRun,
    trigger: github.context.eventName,
  })
}
