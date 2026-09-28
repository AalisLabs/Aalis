import { type ConfigOf, defineConfig } from '@aalis/schema-config';

export const configSchema = defineConfig({
  rootDir: {
    type: 'string',
    label: '存储目录',
    onInvalid: 'error',
    description: '存储 URI（默认 data:/checkpoints）。所有 checkpoint blob 和 manifest 写入此位置。',
    default: 'data:/checkpoints',
  },
  maxFileSize: {
    type: 'number',
    label: '单文件大小上限（字节）',
    description: '超过此大小的文件不做内容快照，只在 manifest 里记录为 skipped。',
    default: 10 * 1024 * 1024,
  },
  keepSessions: {
    type: 'number',
    label: '保留的会话数',
    description: 'GC 阈值。每次提交回合后，若 session 目录数超过此值，删除最早的几个。设为 0 关闭 GC。',
    default: 20,
  },
  scopes: {
    type: 'multiselect',
    label: '启用作用域',
    description:
      '仅在匹配下列 platform:sessionType 的会话中参与 turn 生命周期（建 checkpoint）。格式举例：`webui:*` / `onebot:group` / `*` 表示全部。默认仅 `webui:*`：onebot 等聊天平台不会为每条消息创建 checkpoint。留空数组 = 禁用 checkpoint（仅允许手动 rollback）。',
    // 常用选项之外的作用域也合法
    allowCustom: true,
    options: [
      { label: '所有会话', value: '*' },
      { label: 'WebUI 会话（推荐）', value: 'webui:*' },
      { label: 'OneBot 群聊', value: 'onebot:group' },
      { label: 'OneBot 私聊', value: 'onebot:private' },
      { label: 'CLI', value: 'cli:*' },
    ],
    default: ['webui:*'],
  },
});

export type CheckpointConfig = ConfigOf<typeof configSchema>;
