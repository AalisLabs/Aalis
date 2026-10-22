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
  keepTurns: {
    type: 'number',
    label: '每个会话保留的回合数',
    description:
      '每次提交回合后，这个会话的回合数超过此值就删除最早的几轮（连同备份），只能回滚最近这么多轮；没改文件、只有对话的回合也算一轮。设为 0 不限。',
    default: 200,
  },
  // 按会话字段：在哪一层读都是字面意思，在某个群的场所层选「记」就是这个群记
  coverage: {
    type: 'select',
    label: '记检查点的会话',
    description:
      '哪些会话的回合建检查点（回滚靠它）。「按受众」只在受众只有你的会话里记：WebUI、终端与你自己的 IM 私聊；群与别人的私聊不记，你从 WebUI 发进群的那一轮也不记。',
    default: 'ownerOnly',
    options: [
      { label: '不记', value: 'off' },
      { label: '按受众（只有你时记）', value: 'ownerOnly' },
      { label: '记', value: 'all' },
    ],
    session: { prominence: 'advanced' },
  },
});

export type CheckpointConfig = ConfigOf<typeof configSchema>;
