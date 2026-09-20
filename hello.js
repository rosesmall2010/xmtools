#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * hello 工具：读取 config/hello.yaml 配置并打印问候语。
 * 每个工具对应一个 ts/js 文件，编译产物为同目录下的 js。
 */
const config_1 = require("./lib/config");
const xmcommon_1 = require("xmcommon");
const config = (0, config_1.loadConfig)('hello');
const greeting = config?.greeting ?? 'Hello, World!';
var logger = (0, xmcommon_1.getLogger)('hello');
logger.info(greeting);
