import type { DependencyInfo } from './types'
import { CHANGELOG_TARGET_SECTIONS, COMPONENT_REPOSITORIES, NO_CHANGELOG_CHECKBOX, NO_CHANGELOG_DEPENDENCIES } from './constants'

function heading(line: string): string | undefined {
  const prefix = line.match(/^#{1,6}[ \t]+/)
  return prefix ? line.slice(prefix[0].length).trim() : undefined
}

function insertAfter(body: string, target: RegExp | string, content: string): { body: string, inserted: boolean } {
  const lines = body.split('\n')
  const index = lines.findIndex((line) => {
    const value = heading(line)
    return value !== undefined && (typeof target === 'string' ? value === target : target.test(value))
  })
  if (index === -1)
    return { body, inserted: false }
  lines.splice(index + 1, 0, '', content)
  return { body: lines.join('\n'), inserted: true }
}

function formatReleaseBody(body: string): string {
  return body.trim().replace(/^(#{1,6})(?=\s)/gm, value => '#'.repeat(Math.min(6, value.length + 3)))
}

export function getDependencySummary(deps: DependencyInfo[]): string {
  return ['自动升级以下依赖：', '', ...deps.map(dep => `- \`${dep.name}\` 升级至 \`${dep.version}\``)].join('\n')
}

export function getReleaseNotesMarkdown(deps: DependencyInfo[]): string {
  return deps.map((dep) => {
    const npmUrl = `https://www.npmjs.com/package/${dep.name}/v/${dep.version}`
    return dep.release
      ? `#### [\`${dep.name}@${dep.version}\`](${dep.release.url})\n\n${formatReleaseBody(dep.release.body)}`
      : `#### [\`${dep.name}@${dep.version}\`](${npmUrl})\n\n未在仓库的 CHANGELOG.md 中找到对应版本日志。`
  }).join('\n\n')
}

type ChangelogType = 'build' | 'chore' | 'ci' | 'docs' | 'feat' | 'feat!' | 'fix' | 'perf' | 'refactor' | 'style' | 'test'
interface ChangelogEntry { text: string, type: ChangelogType }

function getChangelogType(value: string): ChangelogType | undefined {
  const heading = value.toLowerCase()
  if (/breaking changes?|破坏性/.test(heading))
    return 'feat!'
  if (/bug fixes?|fixes|修复/.test(heading))
    return 'fix'
  if (/features?|新特性|新增功能/.test(heading))
    return 'feat'
  if (/performance|性能/.test(heading))
    return 'perf'
  if (/documentation|\bdocs?\b|文档/.test(heading))
    return 'docs'
  if (/refactor|重构/.test(heading))
    return 'refactor'
  if (/tests?|测试/.test(heading))
    return 'test'
  if (/\bci\b|持续集成/.test(heading))
    return 'ci'
  if (/build|构建/.test(heading))
    return 'build'
  if (/styles?|代码风格/.test(heading))
    return 'style'
  if (/others?|其他/.test(heading))
    return 'chore'
  return undefined
}

export function parseReleaseChangelog(body: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  const parents: Array<{ indent: number, text: string }> = []
  let type: ChangelogType | undefined
  for (const line of body.split('\n')) {
    const value = heading(line)
    if (value !== undefined) {
      type = getChangelogType(value)
      parents.length = 0
      continue
    }
    const prefix = line.match(/^([ \t]*)[-*+][ \t]+/)
    if (!prefix || !type)
      continue
    const indent = prefix[1].replace(/\t/g, '  ').length
    const text = line.slice(prefix[0].length).trim()
    if (!text)
      continue
    while (parents.length && parents[parents.length - 1].indent >= indent) parents.pop()
    if (text.endsWith(':')) {
      parents.push({ indent, text: text.slice(0, -1) })
      continue
    }
    const parent = parents.map(item => item.text).join(': ')
    entries.push({ type, text: parent ? `${parent}: ${text}` : text })
  }
  return entries
}

function formatType(type: ChangelogType, scoped: boolean): string {
  const breaking = type.endsWith('!')
  const base = breaking ? type.slice(0, -1) : type
  return `${base}${scoped ? '(Icon)' : ''}${breaking ? '!' : ''}`
}

function formatCrossRepositoryLinks(text: string): string {
  return text.replace(/\[#(\d+)\]\((https:\/\/github\.com\/Tencent\/tdesign-icons\/pull\/\1)\)/g, '[icons#$1]($2)')
}

export function getChangelogMarkdown(deps: DependencyInfo[], targetRepo: string): string {
  const scoped = COMPONENT_REPOSITORIES.has(targetRepo)
  return deps.filter(dep => !NO_CHANGELOG_DEPENDENCIES.has(dep.name)).flatMap((dep) => {
    const entries = dep.release ? parseReleaseChangelog(dep.release.body) : []
    return entries.length ? entries.map(entry => `- ${formatType(entry.type, scoped)}: ${formatCrossRepositoryLinks(entry.text)}`) : [`- ${formatType('chore', scoped)}: upgrade ${dep.name} to ${dep.version}`]
  }).join('\n')
}

function buildNoChangelogBody(template?: string): string {
  if (!template)
    return NO_CHANGELOG_CHECKBOX
  const body = template.trim()
  const updated = body.replace(/^- \[ \] 本条 PR 不需要纳入 Changelog\r?$/m, NO_CHANGELOG_CHECKBOX)
  return updated === body ? `${body}\n\n${NO_CHANGELOG_CHECKBOX}` : updated
}

function fillCheckboxes(template: string): string {
  const labels = ['其他', '文档已补充或无须补充', '代码演示已提供或无须提供', 'TypeScript 定义已补充或无须补充', 'Changelog 已提供或无须提供']
  return template.replace(/^- \[ \] (.+)$/gm, (line, label: string) => labels.includes(label.trim()) ? line.replace('[ ]', '[x]') : line).replace(/^- fix\(组件名称\): 处理问题或特性描述 \.\.\.$/gm, '')
}

function insertChangelog(body: string, repo: string, changelog: string): { body: string, inserted: boolean } {
  let result = body
  let inserted = false
  for (const section of CHANGELOG_TARGET_SECTIONS[repo] ?? []) {
    const update = insertAfter(result, section, changelog)
    result = update.body
    inserted ||= update.inserted
  }
  return inserted ? { body: result, inserted } : insertAfter(result, '📝 更新日志', changelog)
}

export function buildPullRequestBody(template: string | undefined, deps: DependencyInfo[], targetRepo: string): string {
  if (deps.length && deps.every(dep => NO_CHANGELOG_DEPENDENCIES.has(dep.name)))
    return buildNoChangelogBody(template)
  const summary = getDependencySummary(deps)
  const background = `${summary}\n\n${getReleaseNotesMarkdown(deps)}`
  const changelog = getChangelogMarkdown(deps, targetRepo)
  if (!template)
    return `## 依赖升级\n\n${background}\n\n## 版本日志\n\n${changelog}`
  let body = fillCheckboxes(template.trim())
  const issue = insertAfter(body, /相关 Issue|related issues?/i, '无')
  body = issue.body
  const backgroundResult = insertAfter(body, /需求背景|解决方案|background|summary|description/i, background)
  body = backgroundResult.body
  const changelogResult = insertChangelog(body, targetRepo, changelog)
  body = changelogResult.body
  const fallback = [!backgroundResult.inserted ? `## 依赖升级\n\n${background}` : '', !changelogResult.inserted ? `## 版本日志\n\n${changelog}` : ''].filter(Boolean)
  return fallback.length ? `${fallback.join('\n\n')}\n\n${body}` : body
}
