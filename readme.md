# xmtools

基于 **Node.js 24 LTS** + **TypeScript** 的命令行工具集合。

## 工程约定

- 根目录下每个 `.ts` 文件对应一个**工具命令**，由 TypeScript 编译为同目录下的 `.js` 文件。
- `lib/` 目录存放工具的**共有代码**，同样编译为同目录下的 `.js`。
- `config/` 目录存放工具所需的配置，采用 **yaml** 格式，配置文件名与工具名一致（如工具 `hello` 对应 `config/hello.yaml`）。
- 公共依赖：`xmcommon`（通用功能库）、`yaml`（配置解析）。

## 编译与运行

```bash
npm install     # 安装依赖
npm run build   # 编译 TypeScript（tsc，产物与源码同目录）
npm run watch   # 监听模式编译
node <工具名>.js   # 运行某个工具
```

## 工具列表

### hello

- **作用**：示例工具。读取 `config/hello.yaml` 中的 `greeting` 配置并打印问候语；配置缺失时输出默认值 `Hello, World!`。
- **启动方式**：`node hello.js`
- **启动参数**：无。

| 配置项 | 说明 | 默认值 |
| --- | --- | --- |
| `greeting` | 要打印的问候语 | `Hello, World!` |

---

> 新增工具：在根目录新建 `<name>.ts`，如需要配置则在 `config/` 下新建 `<name>.yaml`，使用 `lib/config.ts` 中的 `loadConfig()` 加载配置，然后 `npm run build` 编译运行。
