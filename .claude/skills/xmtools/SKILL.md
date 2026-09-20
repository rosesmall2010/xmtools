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

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 编译全部 ts → 同目录 js |
| `npm run watch` | 监听编译 |
| `node <name>.js` | 运行指定工具 |
