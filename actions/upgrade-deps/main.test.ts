import * as exec from '@actions/exec'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchPackageVersion,
  getBranchName,
  getPrTitle,
  parseDependencyInputs,
  resolveDependencyInfos,
  updatePackageDependencies,
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

  it('npm registry 查询失败时中止流程', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 404 }))

    await expect(fetchPackageVersion('@tdesign/missing')).rejects.toThrow(
      'Failed to get @tdesign/missing info from npm registry: status code: 404',
    )
  })

  it('按包管理器执行升级命令', async () => {
    await updatePackageDependencies('npm', ['vite'], 'tdesign-vue-next', '')
    expect(exec.exec).toHaveBeenLastCalledWith('npm', ['install', 'vite'], { cwd: './tdesign-vue-next' })

    await updatePackageDependencies('pnpm', ['@tdesign/site-components'], 'tdesign-vue-next', 'site')
    expect(exec.exec).toHaveBeenLastCalledWith('pnpm', ['up', '--latest', '@tdesign/site-components'], { cwd: 'tdesign-vue-next/site' })
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
