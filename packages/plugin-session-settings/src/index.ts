import { sessionSettings } from '@aalis/api-session-settings';
import { definePlugin } from '@aalis/core';
import { type Caps, uses } from './caps.js';
import { registerCommands } from './commands.js';
import { SessionSettingsProvider } from './provider.js';
import { t } from './texts.js';

// 会话设置：插件配置字段（configSchema 顶层写了 session 的）按平台档、平台类型档、场所与本会话覆盖。读取器在各插件
// 进程内解析（@aalis/api-session-settings），本插件交出各层的原样值、管写入与校验、建子会话时写下的那一层，并登记 /session 系列。
// 会话、场所的增删与字段登记的增减都发 session-settings:changed；宿主文档的变化由宿主发 host-config:changed，这里不转发。
export default definePlugin({
  name: '@aalis/plugin-session-settings',
  displayName: t('displayName'),
  subsystem: 'session',
  provides: [sessionSettings],
  uses,
  apply(caps: Caps) {
    const provider = new SessionSettingsProvider(caps);
    caps.provide.use(sessionSettings, provider, { label: t('displayName') });
    caps.events.use.on('session:created', () => provider.changed());
    caps.events.use.on('session:deleted', () => provider.changed());
    registerCommands(caps, provider.editor);
  },
});
