# Plugin suite / 插件套件

这是仓库显式插件清单的聚合安装入口，**当前清单为空，不提供 Codex、Git 或其他业务功能**。本包用于准备后续组合分发，不建议将空套件发布到 npm。

## 维护

在仓库根目录的 `suite.config.json` 中填写要包含的 `packages/<目录>`，按所需顺序排列，然后运行：

```sh
pnpm suite:generate
pnpm install --ignore-scripts
pnpm check
pnpm check:pack
```

生成器更新本包的 patch 以及 workspace 依赖，不复制功能实现。不要手工修改生成的 patch。加入真实功能时同步更新本说明和中英文描述，移除“空套件”的提示并准确列出能力。

## 安装与迁移

完成开发和验证后，可以通过 DSH 的 Plugins → Add plugin 选择此包目录，或安装已发布的包名。仓库根目录不是 bundle。

同一功能只由一个启用中的 bundle 提供装配。启用本套件前先禁用重叠的单插件 bundle；反向迁移时先禁用本套件。保留稳定插件行 ID，并在隔离 profile 中验证配置和生命周期迁移，不假定重复 ID 自动去重。

## 兼容性与发布

初始版本声明精确兼容 DSH `0.2.3-alpha.2`；这是搭架构时的目标版本，尚未经过真实插件运行和 GUI 验证。增加业务功能后应重新确认实际 API 和兼容性。

`@arkli/dsh-suite` 是待确认的发布命名；发布前替换为拥有权限的 scope，确认许可证，并使用打包产物验证。不会自动发布或安装。

图标为本仓库原创几何图形，不使用第三方品牌资源。
