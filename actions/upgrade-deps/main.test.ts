import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import * as exec from '@actions/exec'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildPullRequestBody,
  fetchDependencyRelease,
  fetchPackageVersion,
  findPnpmWorkspaceFile,
  getBranchName,
  getChangelogMarkdown,
  getPnpmUpdateCommands,
  getPrTitle,
  parseDependencyInputs,
  parseGithubRepository,
  resolveDependencyInfos,
  updatePackageDependencies,
  updatePackageManifestVersions,
  updatePnpmCatalogs,
  updateVersionSpecifier,
  validatePackageManager,
} from './main'

vi.mock('@actions/core', () => ({
  endGroup: vi.fn(),
  error: vi.fn(),
  getBooleanInput: vi.fn(),
  getInput: vi.fn(),
  getMultilineInput: vi.fn(),
  info: vi.fn(),
  setFailed: vi.fn(),
  startGroup: vi.fn(),
  warning: vi.fn(),
}))

vi.mock('@actions/exec', () => ({
  exec: vi.fn(),
  getExecOutput: vi.fn(),
}))

vi.mock('@actions/github', () => ({
  context: {
    eventName: 'workflow_dispatch',
    repo: {
      owner: 'Tencent',
      repo: 'tdesign-vue-next',
    },
  },
  getOctokit: vi.fn(),
}))

describe('升级依赖', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn())
  })

  it('解析空格和换行分隔的依赖输入', () => {
    expect(parseDependencyInputs([
      '@tdesign/site-components @tdesign/theme-generator',
      'vite',
    ])).toEqual([
      '@tdesign/site-components',
      '@tdesign/theme-generator',
      'vite',
    ])
  })

  it('拒绝带版本号的依赖输入', () => {
    expect(() => parseDependencyInputs(['vite@7.0.0'])).toThrow('Dependency versions are not supported')
    expect(() => parseDependencyInputs(['@tdesign/site-components@0.19.1'])).toThrow('Dependency versions are not supported')
  })

  it('拒绝空依赖输入', () => {
    expect(() => parseDependencyInputs(['', '  '])).toThrow('Missing deps input')
  })

  it('拒绝不支持的 package-manager', () => {
    expect(validatePackageManager('pnpm')).toBe('pnpm')
    expect(() => validatePackageManager('bun')).toThrow('Unsupported package-manager "bun"')
  })

  it('全部依赖都查询 npm latest', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ version: '0.19.1' }), { status: 200 }))
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ version: '7.0.0' }), { status: 200 }))

    await expect(resolveDependencyInfos([
      '@tdesign/site-components',
      'vite',
    ])).resolves.toEqual([
      { name: '@tdesign/site-components', version: '0.19.1' },
      { name: 'vite', version: '7.0.0' },
    ])

    expect(fetch).toHaveBeenCalledWith('https://registry.npmjs.org/@tdesign/site-components/latest')
  })

  it('从 npm 元数据保留依赖仓库地址', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      version: '0.5.7',
      repository: {
        type: 'git',
        url: 'git+https://github.com/Tencent/tdesign-icons.git',
      },
    }), { status: 200 }))

    await expect(fetchPackageVersion('tdesign-icons-view')).resolves.toEqual({
      name: 'tdesign-icons-view',
      version: '0.5.7',
      repositoryUrl: 'git+https://github.com/Tencent/tdesign-icons.git',
    })
  })

  it('npm registry 查询失败时中止流程', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 404 }))

    await expect(fetchPackageVersion('@tdesign/missing')).rejects.toThrow(
      'Failed to get @tdesign/missing info from npm registry: status code: 404',
    )
  })

  it('按包管理器执行升级命令', async () => {
    await updatePackageDependencies('npm', [{ name: 'vite', version: '7.0.0' }], 'tdesign-vue-next', '')
    expect(exec.exec).toHaveBeenLastCalledWith('npm', ['install', 'vite'], { cwd: './tdesign-vue-next' })
  })

  it('从 target-dir 查找最近的 pnpm workspace 且不越出 clone', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'upgrade-deps-'))
    const cloneRoot = path.join(tempDir, 'repo')
    const nestedWorkspace = path.join(cloneRoot, 'packages', 'nested')
    const targetDir = path.join(nestedWorkspace, 'apps', 'site')
    const outsideDir = path.join(tempDir, 'outside')

    try {
      await mkdir(targetDir, { recursive: true })
      await mkdir(outsideDir, { recursive: true })
      await writeFile(path.join(cloneRoot, 'pnpm-workspace.yaml'), 'packages: []\n')
      await writeFile(path.join(nestedWorkspace, 'pnpm-workspace.yaml'), 'packages: []\n')

      await expect(findPnpmWorkspaceFile(targetDir, cloneRoot)).resolves.toBe(
        path.join(await realpath(nestedWorkspace), 'pnpm-workspace.yaml'),
      )

      await rm(path.join(nestedWorkspace, 'pnpm-workspace.yaml'))
      await symlink(path.relative(nestedWorkspace, path.join(cloneRoot, 'pnpm-workspace.yaml')), path.join(nestedWorkspace, 'pnpm-workspace.yaml'))
      await expect(findPnpmWorkspaceFile(targetDir, cloneRoot)).resolves.toBe(
        path.join(await realpath(nestedWorkspace), 'pnpm-workspace.yaml'),
      )

      const outsideLink = path.join(cloneRoot, 'outside-link')
      await symlink(outsideDir, outsideLink)
      await expect(findPnpmWorkspaceFile(outsideLink, cloneRoot)).rejects.toThrow('outside clone root')
    }
    finally {
      await rm(tempDir, { force: true, recursive: true })
    }
  })

  it('更新默认和命名 catalog 中的全部匹配项', () => {
    const content = `packages:
  - packages/*

catalog:
  vite: ^6.0.0 # keep comment
  '@tdesign/site-components': '~0.18.0'

catalogs:
  build:
    vite: "6.1.0"
    eslint: ^9.0.0
  legacy:
    vite: 5.4.0
`
    const result = updatePnpmCatalogs(content, [
      { name: 'vite', version: '7.0.0' },
      { name: '@tdesign/site-components', version: '0.19.1' },
    ])

    expect(result.catalogDependencies).toEqual(['vite', '@tdesign/site-components'])
    expect(result.content).toContain('vite: ^7.0.0 # keep comment')
    expect(result.content).toContain(`'@tdesign/site-components': '~0.19.1'`)
    expect(result.content).toContain('vite: "7.0.0"')
    expect(result.content).toContain('vite: 7.0.0')
    expect(result.content).toContain('eslint: ^9.0.0')
  })

  it('更新 JSONC 中与 catalog 依赖混用的直接版本声明', () => {
    const content = `{
  // catalog and direct declarations can coexist
  "dependencies": {
    "vite": "catalog:build"
  },
  "devDependencies": {
    "vite": "^6.0.0",
  },
  "peerDependencies": {
    "vite": "~6.0.0"
  }
}
`
    const result = updatePackageManifestVersions(content, [{ name: 'vite', version: '7.0.0' }])

    expect(result.updated).toBe(true)
    expect(result.content).toContain('// catalog and direct declarations can coexist')
    expect(result.content).toContain('"vite": "catalog:build"')
    expect(result.content).toContain('"vite": "^7.0.0"')
    expect(result.content).toContain('"vite": "~7.0.0"')
  })

  it('复杂 catalog 或直接版本声明会中止更新', () => {
    expect(() => updatePnpmCatalogs('catalog:\n  vite: ">=6 <8"\n', [
      { name: 'vite', version: '7.0.0' },
    ])).toThrow('Unsupported version specifier ">=6 <8" for catalog.vite')

    expect(() => updatePackageManifestVersions(`{
  "dependencies": {
    "vite": "workspace:^6.0.0"
  }
}`, [{ name: 'vite', version: '7.0.0' }])).toThrow('Unsupported version specifier "workspace:^6.0.0"')

    expect(() => updateVersionSpecifier('=6.0.0', '7.0.0', 'catalog.vite')).toThrow('Unsupported version specifier "=6.0.0"')
    expect(() => updateVersionSpecifier('^01.2.3', '7.0.0', 'catalog.vite')).toThrow('Unsupported version specifier "^01.2.3"')
    expect(() => updateVersionSpecifier('^1.2.3-alpha..1', '7.0.0', 'catalog.vite')).toThrow('Unsupported version specifier "^1.2.3-alpha..1"')
  })

  it('catalog 依赖手动更新后只对其他依赖执行 up 并安装 workspace', () => {
    expect(getPnpmUpdateCommands([
      { name: 'vite', version: '7.0.0' },
      { name: 'eslint', version: '10.0.0' },
    ], ['vite'], 'repo/packages/site', '/repo')).toEqual([
      {
        args: ['-r', 'up', '--latest', 'eslint'],
        cwd: 'repo/packages/site',
      },
      {
        args: ['install'],
        cwd: '/repo',
      },
    ])
  })

  it('解析 npm 常见的 GitHub 仓库地址', () => {
    expect(parseGithubRepository('git+https://github.com/Tencent/tdesign-icons.git')).toEqual({
      owner: 'Tencent',
      repo: 'tdesign-icons',
    })
    expect(parseGithubRepository('git@github.com:Tencent/tdesign-icons.git')).toEqual({
      owner: 'Tencent',
      repo: 'tdesign-icons',
    })
    expect(parseGithubRepository('https://gitlab.com/Tencent/tdesign-icons.git')).toBeUndefined()
  })

  it('按 package@version 标签提取 GitHub Release', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      body: '## 🌈 0.5.7\n\n### Bug Fixes\n\n- Fix missing icons',
      html_url: 'https://github.com/Tencent/tdesign-icons/releases/tag/tdesign-icons-view%400.5.7',
    }), { status: 200 }))

    await expect(fetchDependencyRelease({
      name: 'tdesign-icons-view',
      version: '0.5.7',
      repositoryUrl: 'git+https://github.com/Tencent/tdesign-icons.git',
    }, 'test')).resolves.toEqual({
      body: '## 🌈 0.5.7\n\n### Bug Fixes\n\n- Fix missing icons',
      tag: 'tdesign-icons-view@0.5.7',
      url: 'https://github.com/Tencent/tdesign-icons/releases/tag/tdesign-icons-view%400.5.7',
    })

    expect(fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/Tencent/tdesign-icons/releases/tags/tdesign-icons-view%400.5.7',
      {
        headers: {
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    )
  })

  it('release 不存在时依次尝试 version 和 vversion 标签', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 404 }))
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 404 }))
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      body: 'Release notes',
      html_url: 'https://github.com/vitejs/vite/releases/tag/v7.0.0',
    }), { status: 200 }))

    await expect(fetchDependencyRelease({
      name: 'vite',
      version: '7.0.0',
      repositoryUrl: 'https://github.com/vitejs/vite.git',
    }, 'test')).resolves.toMatchObject({ tag: 'v7.0.0' })

    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('根据 TDesign PR 模板填入升级摘要和版本日志', () => {
    const template = `### 🤔 这个 PR 的性质是？

- [ ] 日常 bug 修复
- [ ] 其他

### 🔗 相关 Issue

<!-- 请填写 Issue -->

### 💡 需求背景和解决方案

<!-- 请描述背景 -->

### 📝 更新日志

- fix(组件名称): 处理问题或特性描述 ...

- [ ] 本条 PR 不需要纳入 Changelog

### ☑️ 请求合并前的自查清单

- [ ] 文档已补充或无须补充
- [ ] 代码演示已提供或无须提供
- [ ] TypeScript 定义已补充或无须补充
- [ ] Changelog 已提供或无须提供`
    const body = buildPullRequestBody(template, [{
      name: 'tdesign-icons-view',
      version: '0.5.7',
      release: {
        body: '## 🌈 0.5.7 `2026-07-15`\n\n### 🐞 Bug Fixes\n\n- 修复 fullscreen、logo-wecom-filled、no-result-filled、tree-list、wifi-no-filled 5 个图标搜索缺失 @liweijie0812 ([#264](https://github.com/Tencent/tdesign-icons/pull/264))',
        tag: 'tdesign-icons-view@0.5.7',
        url: 'https://github.com/Tencent/tdesign-icons/releases/tag/tdesign-icons-view%400.5.7',
      },
    }], 'tdesign')

    expect(body).toContain('### 💡 需求背景和解决方案\n\n自动升级以下依赖：')
    expect(body).toContain('### 🔗 相关 Issue\n\n无')
    expect(body).toContain('- `tdesign-icons-view` 升级至 `0.5.7`')
    expect(body).toContain('#### [`tdesign-icons-view@0.5.7`]')
    expect(body).toContain('##### 🌈 0.5.7 `2026-07-15`\n\n###### 🐞 Bug Fixes')
    expect(body).toContain('### 📝 更新日志\n\n- fix: 修复 fullscreen、logo-wecom-filled、no-result-filled、tree-list、wifi-no-filled 5 个图标搜索缺失 @liweijie0812 ([#264](https://github.com/Tencent/tdesign-icons/pull/264))')
    expect(body).not.toContain('fix(组件名称)')
    expect(body).toContain('- [x] 其他')
    expect(body).toContain('- [ ] 本条 PR 不需要纳入 Changelog')
    expect(body).toContain('- [x] Changelog 已提供或无须提供')
  })

  it('仅升级无需 Changelog 的依赖时只勾选对应选项', () => {
    const template = `### 🤔 这个 PR 的性质是？

- [ ] 其他

### 🔗 相关 Issue

<!-- 请填写 Issue -->

### 💡 需求背景和解决方案

<!-- 请描述背景 -->

### 📝 更新日志

- [ ] 本条 PR 不需要纳入 Changelog

#### tdesign-vue-next
<!-- 主包日志 -->

### ☑️ 请求合并前的自查清单

- [ ] 文档已补充或无须补充
- [ ] Changelog 已提供或无须提供`
    const body = buildPullRequestBody(template, [
      { name: '@tdesign/site-components', version: '0.19.1' },
      { name: '@tdesign/theme-generator', version: '1.2.5' },
    ], 'tdesign-vue-next')

    expect(body).toBe(template.replace(
      '- [ ] 本条 PR 不需要纳入 Changelog',
      '- [x] 本条 PR 不需要纳入 Changelog',
    ))
    expect(body).not.toContain('自动升级以下依赖')
    expect(body).not.toContain('\n无\n')
    expect(body).toContain('- [ ] 其他')
    expect(body).toContain('- [ ] Changelog 已提供或无须提供')
  })

  it.each([
    '@tdesign/site-components',
    '@tdesign/theme-generator',
  ])('单独升级 %s 时无需 Changelog', (name) => {
    expect(buildPullRequestBody(
      '- [ ] 本条 PR 不需要纳入 Changelog',
      [{ name, version: '1.0.0' }],
      'tdesign-vue-next',
    )).toBe('- [x] 本条 PR 不需要纳入 Changelog')
  })

  it('无需 Changelog 的依赖在没有模板时生成最小正文', () => {
    expect(buildPullRequestBody(undefined, [
      { name: '@tdesign/site-components', version: '0.19.1' },
    ], 'tdesign-vue-next')).toBe('- [x] 本条 PR 不需要纳入 Changelog')
  })

  it('混合升级时背景保留全部依赖但 Changelog 忽略特殊依赖', () => {
    const template = `### 💡 需求背景和解决方案

### 📝 更新日志

- [ ] 本条 PR 不需要纳入 Changelog

#### tdesign-vue-next
<!-- 主包日志 -->`
    const body = buildPullRequestBody(template, [{
      name: '@tdesign/site-components',
      version: '0.19.1',
      release: {
        body: '## 0.19.1\n\n### Features\n\n- Update site navigation',
        tag: '@tdesign/site-components@0.19.1',
        url: 'https://github.com/Tencent/tdesign/releases/tag/site-components',
      },
    }, {
      name: 'tdesign-icons-view',
      version: '0.5.7',
      release: {
        body: '## 0.5.7\n\n### Bug Fixes\n\n- Fix missing icons',
        tag: 'tdesign-icons-view@0.5.7',
        url: 'https://github.com/Tencent/tdesign-icons/releases/tag/tdesign-icons-view%400.5.7',
      },
    }], 'tdesign-vue-next')

    expect(body).toContain('- `@tdesign/site-components` 升级至 `0.19.1`')
    expect(body).toContain('Update site navigation')
    expect(body).toContain('#### tdesign-vue-next\n\n- fix(Icon): Fix missing icons')
    expect(body).not.toContain('feat(Icon): Update site navigation')
    expect(body).toContain('- [ ] 本条 PR 不需要纳入 Changelog')
  })

  it('将 release 分类转换成 Conventional Changelog', () => {
    const changelog = getChangelogMarkdown([{
      name: 'tdesign-icons-view',
      version: '0.5.7',
      release: {
        body: `## 0.5.7

### Breaking Changes
- Remove legacy icon

### Features
- Add new icon

### Bug Fixes
- \`Icon\`:
  - Fix missing icon

### Performance
- Reduce bundle size

### Documentation
- Update icon docs

### Refactor
- Simplify loader

### Others
- Update tooling`,
        tag: 'tdesign-icons-view@0.5.7',
        url: 'https://github.com/Tencent/tdesign-icons/releases/tag/tdesign-icons-view%400.5.7',
      },
    }], 'tdesign-vue-next')

    expect(changelog).toBe(`- feat(Icon)!: Remove legacy icon
- feat(Icon): Add new icon
- fix(Icon): \`Icon\`: Fix missing icon
- perf(Icon): Reduce bundle size
- docs(Icon): Update icon docs
- refactor(Icon): Simplify loader
- chore(Icon): Update tooling`)
  })

  it('组件仓库将日志写入目标主包区块', () => {
    const template = `### 💡 需求背景和解决方案

### 📝 更新日志

#### tdesign-vue-next
<!-- 主包日志 -->

#### @tdesign-vue-next/chat
<!-- Chat 日志 -->`
    const body = buildPullRequestBody(template, [{
      name: 'tdesign-icons-view',
      version: '0.5.7',
      release: {
        body: '## 0.5.7\n\n### Bug Fixes\n\n- Fix missing icons',
        tag: 'tdesign-icons-view@0.5.7',
        url: 'https://github.com/Tencent/tdesign-icons/releases/tag/tdesign-icons-view%400.5.7',
      },
    }], 'tdesign-vue-next')

    expect(body).toContain('#### tdesign-vue-next\n\n- fix(Icon): Fix missing icons\n<!-- 主包日志 -->')
    expect(body).not.toContain('#### @tdesign-vue-next/chat\n\n- fix(Icon)')
  })

  it('小程序仓库同时写入主包和 uniapp 区块', () => {
    const template = `### 💡 需求背景和解决方案

### 📝 更新日志

#### tdesign-miniprogram
<!-- 小程序日志 -->

#### @tdesign/uniapp
<!-- UniApp 日志 -->

#### @tdesign/uniapp-chat
<!-- Chat 日志 -->`
    const body = buildPullRequestBody(template, [{
      name: 'tdesign-icons-view',
      version: '0.5.7',
      release: {
        body: '## 0.5.7\n\n### Features\n\n- Add new icon',
        tag: 'tdesign-icons-view@0.5.7',
        url: 'https://github.com/Tencent/tdesign-icons/releases/tag/tdesign-icons-view%400.5.7',
      },
    }], 'tdesign-miniprogram')

    expect(body.match(/- feat\(Icon\): Add new icon/g)).toHaveLength(2)
    expect(body).toContain('#### tdesign-miniprogram\n\n- feat(Icon): Add new icon')
    expect(body).toContain('#### @tdesign/uniapp\n\n- feat(Icon): Add new icon')
    expect(body).not.toContain('#### @tdesign/uniapp-chat\n\n- feat(Icon)')
  })

  it('release 缺失时根据目标仓库生成 chore 日志', () => {
    const deps = [{ name: 'vite', version: '7.0.0' }]
    expect(getChangelogMarkdown(deps, 'tdesign-mobile-vue')).toBe('- chore(Icon): upgrade vite to 7.0.0')
    expect(getChangelogMarkdown(deps, 'tdesign')).toBe('- chore: upgrade vite to 7.0.0')
  })

  it.each([
    'tdesign-flutter',
    'tdesign-miniprogram',
    'tdesign-mobile-react',
    'tdesign-mobile-vue',
    'tdesign-react',
    'tdesign-vue',
    'tdesign-vue-next',
  ])('%s 使用 Icon scope', (repo) => {
    expect(getChangelogMarkdown([{
      name: 'vite',
      version: '7.0.0',
      release: {
        body: '## 7.0.0\n\n### Bug Fixes\n\n- Fix issue',
        tag: 'v7.0.0',
        url: 'https://github.com/vitejs/vite/releases/tag/v7.0.0',
      },
    }], repo)).toBe('- fix(Icon): Fix issue')
  })

  it('模板没有已知区块时在模板前添加升级内容', () => {
    const body = buildPullRequestBody('## Checklist\n\n- [ ] Reviewed', [{
      name: 'vite',
      version: '7.0.0',
    }], 'unknown-repo')

    expect(body).toMatch(/^## 依赖升级/)
    expect(body).toContain('## 版本日志')
    expect(body).toContain('未找到对应的 GitHub Release Notes。')
    expect(body).toContain('- chore: upgrade vite to 7.0.0')
    expect(body).toContain('## Checklist\n\n- [ ] Reviewed')
  })

  it('生成分支名和默认 PR 标题', () => {
    const deps = [
      { name: '@tdesign/site-components', version: '0.19.1' },
      { name: 'vite', version: '^7.0.0' },
    ]

    expect(getBranchName(deps)).toBe('chore/deps/upgrade-tdesign-site-components-0.19.1-vite-7.0.0')
    expect(getPrTitle(deps)).toBe('chore: upgrade @tdesign/site-components to 0.19.1, vite to ^7.0.0')
  })
})
