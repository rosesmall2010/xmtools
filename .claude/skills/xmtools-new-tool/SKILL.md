---
name: xmtools-new-tool
description: 在 xmtools 项目中新增一个工具命令的步骤和模板。当需要创建新的 <name>.ts 工具时使用。
---

# 新增工具

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
4. 完成后加载 `xmtools-readme-sync` 同步 readme。
