# workflows

TDesign 共享的 GitHub Actions 工作流。

## 共享 CI 文件 (reusable-*)

| 文件 | 说明 |
|------|------|
| `reusable-unit-test.yml` | 单元测试，支持自定义 node 版本、包管理器等 |
| `reusable-pr-preview.yml` | PR 预览部署，将构建产物部署到 Surge |
| `reusable-publish-npm.yml` | NPM 包发布 |

## 自定义 Actions (actions/*)

| Action | 说明 |
|--------|------|
| `check-email` | 检查 commit 邮箱是否符合规范（不能是 @tencent.com） |
| `close-release-issue` | 合并 release 分支时关闭带有特定标签的 issues |
| `cnb-delete-branch` | 删除 CNB 分支前先关闭关联的 PR |
| `issues-helper` | GitHub issue 管理工具，支持创建评论、更新 issue、标记重复 issue |
| `maintain-one-comment` | 为 issue/PR 维护一条唯一评论，重复执行时更新而不是新增 |
| `setup-flutter` | 设置 Flutter 环境 |
| `setup-surge` | 部署到 Surge |
| `upgrade-deps` | 升级依赖版本 |

## 使用方式

### reusable workflows

供 TDesign 各子仓库引用，通过 `jobs.<job_id>.uses` 调用：

```yaml
jobs:
  test:
    uses: TDesignOteam/workflows/.github/workflows/reusable-unit-test.yml@main
    with:
      node-version: '22'
      package-manager: pnpm
```

### actions

通过 `uses` 调用自定义 Action：

```yaml
steps:
  - uses: TDesignOteam/workflows/actions/check-email@main
  - uses: TDesignOteam/workflows/actions/cnb-delete-branch@main
    with:
      token: ${{ secrets.CNB_TOKEN }}
      repo: ${{ github.repository }}
      branch: ${{ github.ref_name }}
```
