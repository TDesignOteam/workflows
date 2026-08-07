export interface TriggerContext {
  repo: string
  owner: string
  token: string
  dryRun: boolean
}

export interface DependencyInfo {
  name: string
  repositoryDirectory?: string
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

export interface CatalogUpdateResult {
  catalogDependencies: string[]
  content: string
}

export interface PackageManifestUpdateResult {
  content: string
  updated: boolean
}

export interface PnpmUpdateCommand {
  args: string[]
  cwd: string
}

export interface FileUpdate {
  content: string
  filePath: string
}
