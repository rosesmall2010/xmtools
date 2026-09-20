#!/usr/bin/env node
/**
 * hello 工具：读取 config/hello.yaml 配置并打印问候语。
 * 每个工具对应一个 ts/js 文件，编译产物为同目录下的 js。
 */
import { loadConfig } from './lib/config';
import { getLogger } from 'xmcommon'

interface HelloConfig {
    greeting: string;
}

const config = loadConfig<HelloConfig>('hello');
const greeting = config?.greeting ?? 'Hello, World!';
var logger = getLogger('hello');
logger.info(greeting);
