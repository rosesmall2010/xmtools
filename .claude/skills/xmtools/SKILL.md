---
name: xmtools
description: xmtools 工具集合的开发入口——目录约定、常用命令，以及按任务路由到子 skill（新增工具/readme 同步/git 提交）。在此工程中开发前先看这个。
---

# xmtools 工具开发入口

基于 Node.js 24 LTS + TypeScript 的命令行工具集合。

## 目录约定

- 根目录每个 `.ts` = 一个工具命令，`tsc` 编译成**同目录 `.js`**
- `lib/` = 工具共有代码，同样编译成同目录 `.js`
- `config/` = yaml 配置，文件名与工具名一致（`hello.ts` ↔ `config/hello.yaml`）
- 公共依赖：`xmcommon`、`yaml`

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 编译全部 ts → 同目录 js |
| `npm run watch` | 监听编译 |
| `node <name>.js` | 运行指定工具 |

## 按任务加载子 skill

| 任务 | 加载 |
| --- | --- |
| 新增一个工具命令 | `xmtools-new-tool` |
| 新增/修改/删除工具后同步文档 | `xmtools-readme-sync` |
| 需要执行 git 提交 | `xmtools-git-commit` |
