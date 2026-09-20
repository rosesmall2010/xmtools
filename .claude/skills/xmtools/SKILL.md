---
name: xmtools
description: xmtools 工具集合的开发流程：新增/维护工具命令、加载 yaml 配置、编译与运行。当需要在此工程中创建或修改工具时使用。
---

# xmtools 工具开发

基于 Node.js 24 LTS + TypeScript 的命令行工具集合。

## 目录约定

- 根目录每个 `.ts` = 一个工具命令，`tsc` 编译成**同目录 `.js`**
- `lib/` = 工具共有代码，同样编译成同目录 `.js`
- `config/` = yaml 配置，文件名与工具名一致（`hello.ts` ↔ `config/hello.yaml`）
- 公共依赖：`xmcommon`、`yaml`

## 新增工具

1. 根目录新建 `<name>.ts`，模板：

```ts
#!/usr/bin/env node
import { loadConfig } from './lib/config';

interface NameConfig {
    // 配置项
}

const config = loadConfig<NameConfig>('name');
// 工具逻辑
```

2. 如需配置，在 `config/` 新建 `<name>.yaml`，用 `loadConfig<NameConfig>('name')` 加载（文件不存在时返回 `null`）。
3. `npm run build` 编译，`node <name>.js` 运行。

## readme 同步规则

**每次新增、修改或删除一个工具命令，都必须同步更新 `readme.md` 的"工具列表"**：

- 新增：加入该工具的介绍，包括作用、启动方式、启动参数、配置项表（如有）、输出说明。
- 修改：若行为、参数、配置项发生变化，同步更新对应描述。
- 删除：移除对应章节。

## Git 提交规则

- 提交作者**固定使用 `rosesmall2010`**（`rosesmall2010@gmail.com`），不要使用其他用户身份。
- 提交前清理运行产物（如 `findequ-result-*.json`），不要提交进仓库。
- commit message **不要**附加 `Co-Authored-By` 之类的归因行。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 编译全部 ts → 同目录 js |
| `npm run watch` | 监听编译 |
| `node <name>.js` | 运行指定工具 |
