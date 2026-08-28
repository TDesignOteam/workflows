import type { ParseError } from 'jsonc-parser'
import type { DependencyField, PackageManager } from './constants'
import type { DependencyInfo, PackageManifestUpdateResult } from './types'
import { applyEdits, modify, parse as parseJson } from 'jsonc-parser'
import { DEPENDENCY_FIELDS, PACKAGE_MANAGER_COMMANDS, SEMVER_PATTERN } from './constants'

function slugify(value: string): string {
  return value.replace(/@/g, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
}

export function getBranchName(deps: DependencyInfo[]): string {
  return `chore/deps/upgrade-${deps.map(dep => `${slugify(dep.name)}-${slugify(dep.version)}`).join('-')}`
}

export function getPrTitle(deps: DependencyInfo[]): string {
  return `chore: upgrade ${deps.map(dep => `${dep.name} to ${dep.version}`).join(', ')}`
}

export function parseDependencyName(spec: string): string {
  const value = spec.trim()
  if (!value)
    throw new Error('Empty dependency name')
  const separator = value.startsWith('@') ? value.indexOf('@', value.indexOf('/') + 1) : value.lastIndexOf('@')
  if (separator > 0)
    throw new Error(`Dependency versions are not supported: ${spec}. Please pass package names only.`)
  return value
}

export function parseDependencyInputs(inputs: string[]): string[] {
  const deps = inputs.flatMap(input => input.split(/\s+/)).map(item => item.trim()).filter(Boolean).map(parseDependencyName)
  if (!deps.length)
    throw new Error('Missing deps input')
  return deps
}

export function validatePackageManager(packageManager: string): PackageManager {
  if (packageManager in PACKAGE_MANAGER_COMMANDS)
    return packageManager as PackageManager
  throw new Error(`Unsupported package-manager "${packageManager}". Supported values: npm, yarn, pnpm.`)
}

export function updateVersionSpecifier(specifier: string, version: string, location: string): string {
  const match = specifier.match(SEMVER_PATTERN)
  if (!match)
    throw new Error(`Unsupported version specifier "${specifier}" for ${location}. Supported formats: ^1.2.3, ~1.2.3, or 1.2.3.`)
  const target = version.match(SEMVER_PATTERN)
  if (!target || target[1])
    throw new Error(`Invalid target version "${version}" for ${location}`)
  return `${match[1]}${target[2]}`
}

export function updatePackageManifestVersions(
  content: string,
  deps: DependencyInfo[],
  manifestPath = 'package.json',
  dependencyFields: readonly DependencyField[] = DEPENDENCY_FIELDS,
): PackageManifestUpdateResult {
  const errors: ParseError[] = []
  const manifest = parseJson(content, errors, { allowTrailingComma: true }) as Record<string, unknown> | undefined
  if (errors.length || !manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    throw new Error(`Failed to parse ${manifestPath}`)

  let updatedContent = content
  let updated = false
  for (const field of dependencyFields) {
    const dependencies = manifest[field]
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies))
      continue
    for (const dep of deps) {
      const specifier = (dependencies as Record<string, unknown>)[dep.name]
      if (specifier === undefined)
        continue
      if (typeof specifier !== 'string')
        throw new Error(`Unsupported version specifier for ${manifestPath}#${field}.${dep.name}: expected a string`)
      if (specifier.startsWith('catalog:'))
        continue
      const nextSpecifier = updateVersionSpecifier(specifier, dep.version, `${manifestPath}#${field}.${dep.name}`)
      if (nextSpecifier === specifier)
        continue
      updatedContent = applyEdits(updatedContent, modify(updatedContent, [field, dep.name], nextSpecifier, {}))
      updated = true
    }
  }
  return { content: updatedContent, updated }
}

export async function fetchPackageVersion(pkg: string): Promise<DependencyInfo> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${pkg}/latest`)
    if (!response.ok)
      throw new Error(`status code: ${response.status}`)
    const { version, repository } = await response.json() as { repository?: string | { directory?: string, url?: string }, version?: string }
    if (!version)
      throw new Error('no version found')
    const repositoryUrl = typeof repository === 'string' ? repository : repository?.url
    const repositoryDirectory = typeof repository === 'object' ? repository?.directory : undefined
    return { name: pkg, version, ...(repositoryUrl ? { repositoryUrl } : {}), ...(repositoryDirectory ? { repositoryDirectory } : {}) }
  }
  catch (error) {
    throw new Error(`Failed to get ${pkg} info from npm registry: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function resolveDependencyInfos(deps: string[]): Promise<DependencyInfo[]> {
  return Promise.all(deps.map(fetchPackageVersion))
}
