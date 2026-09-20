// ============================================================
// host-services.ts — 宿主管理面的服务描述符
//
// App 在根激活上提供的普通调用型服务。管理类插件（WebUI、市场、CLI）在 uses 里显式声明才拿得到；
// 插件自己的配置视图是内置能力 `config`，这里的 hostConfig 是整份配置的读写与落盘。
// ============================================================

import type { AppService, PluginManagerService } from '../types/app.js';

import { defineService } from '../context/binding.js';
import type { ConfigManager } from '../context/config.js';

export const appService = defineService<AppService>('app');
export const pluginsService = defineService<PluginManagerService>('plugins');
export const hostConfig = defineService<ConfigManager>('host-config');
