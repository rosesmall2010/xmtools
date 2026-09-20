/**
 * 工具配置的公共加载逻辑
 *
 * 约定：config 目录下存放 yaml 配置文件，配置文件名与工具代码名一致（不含扩展名）。
 * 例如 hello 工具的配置为 config/hello.yaml。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';

/** 配置文件根目录 */
export const CONFIG_DIR = path.resolve(__dirname, '..', 'config');

/**
 * 加载工具的 yaml 配置
 * @param toolName 工具名（与 config 下的配置文件名一致）
 * @returns 解析后的配置对象，文件不存在时返回 null
 */
export function loadConfig<T>(toolName: string): T | null {
    const filePath = path.join(CONFIG_DIR, `${toolName}.yaml`);
    if (!fs.existsSync(filePath)) {
        return null;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return YAML.parse(content) as T;
}
