# DSH plugins monorepo

一个用于开发和分发 DeepSeek Harness 插件的 pnpm + TypeScript monorepo：**单个功能可独立安装，suite 可聚合安装**。

## 当前状态

已实现 workspace、Host 插件脚手架、聚合装配生成器、发布内容校验、独立版本管理和 CI。

**还没有 Codex 或其他业务插件。** `packages/suite` 当前为空；`templates/host-plugin` 是默认停用的开发骨架，不声称提供功能。没有修改用户 DSH profile，也没有发布 npm 包。

## 快速开始

需要 **Node.js ≥ 22.18** 和 **pnpm 11.28.5**。使用你已有的 pnpm/Corepack 安装方式；仓库固定 `packageManager` 版本。

```sh
pnpm install --ignore-scripts
pnpm check
pnpm check:pack
```

pnpm 11 的工作区设置位于 `pnpm-workspace.yaml`。依赖安装脚本默认禁用，store/cache 位于本仓库忽略的目录中；不需要写入 DSH profile。

### 新增一个插件

以下 `your-scope` 必须替换为你实际使用的 npm scope；`codex` 是示例名字，不代表已经实现 Codex 接入。

```sh
pnpm create:plugin codex --scope your-scope --dsh-version 0.2.3-alpha.2
pnpm install --ignore-scripts
pnpm --filter @your-scope/dsh-codex build
```

然后：

1. 在 `packages/codex/src/index.ts` 实现功能；先查目标 DSH 版本及真实 API。
2. 按需要添加依赖、Config schema、工具/事件/服务，并正确释放生命周期资源。
3. 添加该包的测试与 `test` script，更新 README、双语 locale 和图标。
4. 完成实现后，将该包 patch 的 `disabled: true` 改为需要的默认状态。
5. 运行检查；明确请求在隔离 DSH profile 中安装和验证。

脚手架不会覆盖已有目录，不会自动加入 suite，不会安装到 DSH。

### 加入 suite

编辑 `suite.config.json`：

```json
{
  "packages": ["packages/codex"]
}
```

执行：

```sh
pnpm suite:generate
pnpm install --ignore-scripts
pnpm check
pnpm check:pack
```

生成器更新 suite patch 和 workspace 依赖。**仅 npm 依赖不会递归激活子 bundle 的 patch。** 单插件与 suite 应避免同时启用重叠装配。

完整流程见 [插件开发指南](docs/plugin-development.md)。

## 常用命令

| 命令 | 用途 |
|---|---|
| `pnpm create:plugin <slug> --scope <scope>` | 生成一个默认停用的 Host 开发骨架 |
| `pnpm suite:generate` | 按显式清单生成 suite patch 和依赖 |
| `pnpm suite:check` | 只检查生成内容是否漂移，不写文件 |
| `pnpm build` | 生成 suite，然后按 workspace 顺序构建各包 |
| `pnpm typecheck` | 检查工具脚本及各包类型 |
| `pnpm test` | 工具单元测试、离线分发集成测试及各包测试 |
| `pnpm check:packages` | 检查 bundle 入口、patch、元数据和资源 |
| `pnpm check:pack` | 真正执行 pnpm pack 并校验 tarball 内容 |
| `pnpm check` | 生成一致性、构建、类型检查、测试与目录资源校验 |
| `pnpm changeset` | 为用户可见变更记录独立包版本说明 |
| `pnpm version:packages` | 应用 Changesets，重新生成 suite 并更新锁文件 |

`pnpm check` **不会替代** `pnpm check:pack`；CI 两者都执行。打包结果保留在忽略的 `.artifacts/pack-*` 中供检查。

## 目录

```text
packages/suite/       聚合 bundle（初始为空）
templates/host-plugin/ 开发模板，不是业务插件
scripts/             脚手架、装配和包校验工具
tests/               工具及隔离分发测试
docs/                开发和发布指南
.changeset/          独立版本管理配置
.github/workflows/   CI（不自动发布）
```

后续功能包放在 `packages/<slug>`。普通共享库可以放在 `packages/shared`，按真实复用需求再添加，不预先创建空库。

## 工具的支持边界

- suite 生成器目前只支持单个 YAML patch 文件、平坦 `insert` 和普通 JSON 配置；拒绝覆盖、分组、相对插件名、YAML 标签（包括 `!!js`）、锚点和别名。不支持的形式会报错，不会悄悄丢字段。
- bundle 校验器采用相同的受限 patch 方言。自行使用更复杂 DSH 特性前应扩展生成器、校验器和测试，而不是关掉检查。
- 当前发布依赖策略支持 registry SemVer 范围；打包后拒绝 `workspace:`、本地路径、Git/URL 和其他非 SemVer 依赖声明。需要其它来源时先明确扩展策略。
- 校验器检查资源存在和基本格式，不是完整 DSH Loader 或图像渲染器。Host 自引用入口要求显式 exports；不实现完整通配符和自定义条件解析。
- 分发测试从模板临时生成两个默认停用的 fixture，编译、打包，并在仓库外离线安装单插件和 suite，确认运行时依赖可解析。它不等于真实 DSH 激活、迁移或 UI 验证。

## 发布前必须确认

- 将 suite 的示例包名 `@arkli/dsh-suite` 改成拥有发布权限的名称；功能包 scope 由创建命令显式指定。
- 初始 DSH 范围为精确 `0.2.3-alpha.2`，不是对其它版本的兼容性承诺；开发时重新确认。
- 选择合适的许可证和仓库地址；此基础设施没有替你作许可证决定。
- 将 `.changeset/config.json` 的 `baseBranch` 与实际默认分支对齐（默认 `main`）。
- 实现业务功能并移除骨架/空套件描述后再发布，不发布没有功能的占位包。
- 完整通过 `pnpm check && pnpm check:pack`，再按 [开发指南](docs/plugin-development.md) 做隔离 DSH 验证。

没有自动发布脚本或凭证配置；发布、Git 推送和修改 profile 必须由维护者明确决定。
