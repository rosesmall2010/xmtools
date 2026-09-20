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

### findequ

- **作用**：查找重复文件。递归扫描指定目录下所有文件，计算每个文件的 MD5，按 MD5 分组输出重复文件统计。
- **启动方式**：`node findequ.js <目录路径>`
- **启动参数**：

| 参数 | 说明 |
| --- | --- |
| `<目录路径>` | 要扫描的目标目录（必填） |

- **输出**：处理过程中显示多行进度面板（当前文件、进度条、文件数、字节数、速度/耗时）；结果 JSON 保存到当前目录 `findequ-result-<时间戳>.json`，只打印保存路径，不打印内容。

结果 JSON 结构：

```json
{
  "path": "扫描的目录绝对路径",
  "file": {
    "md5值": {
      "size": "文件大小（可读格式）",
      "count": "相同 md5 的文件数",
      "paths": ["相对路径1", "相对路径2", "..."]
    }
  },
  "total": {
    "fileCount": 文件总数,
    "totalSize": 文件总大小,
    "duplicateCount": 重复文件总数,
    "duplicateSize": 重复文件总大小,
    "md5Count": 有重复的 md5 个数
  }
}
```

- **示例**：`node findequ.js ~/Downloads`

### mvequ

- **作用**：读取 `findequ` 的结果 JSON，对每组重复文件（同一 MD5、count > 1），保留第一个文件在原处，其余的按相对路径**移动**（非复制）到目标目录，保持原有目录结构。
- **启动方式**：`node mvequ.js <findequ-result.json> <目标目录>`
- **启动参数**：

| 参数 | 说明 |
| --- | --- |
| `<findequ-result.json>` | `findequ` 输出的结果文件路径（必填） |
| `<目标目录>` | 重复文件移动到的目标目录（必填） |

- **行为说明**：源文件不存在或目标位置已存在同名文件时跳过并警告；跨设备移动失败时自动退化为复制后删除源文件。
- **输出**：处理结果保存到当前目录 `mvequ-result-<时间戳>.json`，只打印保存路径，不打印内容。

结果 JSON 结构：

```json
{
  "source": "findequ 结果中的源目录",
  "target": "目标目录绝对路径",
  "moved": ["已移动的相对路径", "..."],
  "skipped": [
    { "path": "相对路径", "reason": "跳过原因（源文件不存在 / 目标已存在 / 移动失败: ...）" }
  ],
  "total": { "movedCount": 已移动文件数, "skippedCount": 跳过文件数 }
}
```

- **示例**：`node mvequ.js findequ-result-123.json /data/dup-out`

### renametag

- **作用**：修正文件名——把开头的"数字前缀"或"3D / 3 D 前缀"移动到扩展名之前。递归扫描目录下所有文件。
  - 数字前缀：`数字.中间名.扩展名` → `中间名.数字.扩展名`（如 `13456.AAA.mp3` → `AAA.13456.mp3`）；若只有"数字.扩展名"两段（如 `12345.mp3`），不处理。
  - `3D`/`3 D` 前缀：紧贴文件名开头（无需点分隔）→ 移到扩展名前（如 `3DAAA.mp3` → `AAA.3D.mp3`）。
- **启动方式**：`node renametag.js <目录路径>`
- **启动参数**：

| 参数 | 说明 |
| --- | --- |
| `<目录路径>` | 要处理的目标目录（必填） |

- **行为说明**：重命名后的目标文件名已存在时跳过并警告。
- **输出**：处理结果保存到当前目录 `renametag-result-<时间戳>.json`，只打印保存路径，不打印内容。

结果 JSON 结构：

```json
{
  "path": "扫描的目录绝对路径",
  "renamed": [{ "from": "原相对路径", "to": "新相对路径" }],
  "skipped": [{ "path": "相对路径", "reason": "跳过原因（目标文件名已存在 / 重命名失败: ...）" }],
  "total": { "renamedCount": 已重命名文件数, "skippedCount": 跳过文件数 }
}
```

- **示例**：`node renametag.js ~/Music`

---

> 新增工具：在根目录新建 `<name>.ts`，如需要配置则在 `config/` 下新建 `<name>.yaml`，使用 `lib/config.ts` 中的 `loadConfig()` 加载配置，然后 `npm run build` 编译运行。
