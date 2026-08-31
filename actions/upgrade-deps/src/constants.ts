export const PACKAGE_MANAGER_COMMANDS = {
  pnpm: { cmd: 'pnpm', args: ['up', '-r'] },
  yarn: { cmd: 'yarn', args: ['upgrade', '--latest'] },
  npm: { cmd: 'npm', args: ['install'] },
} as const

export const PR_TEMPLATE_PATHS = [
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md',
  'pull_request_template.md',
  'docs/PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
]

export const COMPONENT_REPOSITORIES = new Set([
  'tdesign-flutter',
  'tdesign-miniprogram',
  'tdesign-mobile-react',
  'tdesign-mobile-vue',
  'tdesign-react',
  'tdesign-vue',
  'tdesign-vue-next',
])

export const SNAPSHOT_UPDATE_SCRIPTS: Record<string, string> = {
  'tdesign-mobile-react': 'test:update',
  'tdesign-mobile-vue': 'test:update',
  'tdesign-react': 'test:update',
  'tdesign-vue': 'test:update',
  'tdesign-vue-next': 'test:vue:update',
}

export const NO_CHANGELOG_DEPENDENCIES = new Set([
  '@tdesign/site-components',
  '@tdesign/theme-generator',
])

export const NO_CHANGELOG_CHECKBOX = '- [x] 本条 PR 不需要纳入 Changelog'

export const CHANGELOG_TARGET_SECTIONS: Record<string, string[]> = {
  'tdesign-miniprogram': ['tdesign-miniprogram', '@tdesign/uniapp'],
  'tdesign-react': ['tdesign-react'],
  'tdesign-vue-next': ['tdesign-vue-next'],
}

export const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies'] as const
export type DependencyField = typeof DEPENDENCY_FIELDS[number]
export type PackageManager = keyof typeof PACKAGE_MANAGER_COMMANDS

export const SEMVER_PATTERN = /^([~^]?)((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-z-][0-9a-z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-z-][0-9a-z-]*))*)?(?:\+[0-9a-z-]+(?:\.[0-9a-z-]+)*)?)$/i
