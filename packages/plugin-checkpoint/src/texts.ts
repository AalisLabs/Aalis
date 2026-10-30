// 本插件自己的原文字典：显示名与配置项，/clear 的类型显示名与结果行，没回滚成的原因，rootDir 的配置报错
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '回滚检查点',
  rootDirLabel: '存储目录',
  rootDirDescription: '存储 URI（默认 data:/checkpoints）。所有 checkpoint blob 和 manifest 写入此位置。',
  maxFileSizeLabel: '单文件大小上限（字节）',
  maxFileSizeDescription: '超过此大小的文件不做内容快照，只在 manifest 里记录为 skipped。',
  keepSessionsLabel: '保留的会话数',
  keepSessionsDescription: 'GC 阈值。每次提交回合后，若 session 目录数超过此值，删除最早的几个。设为 0 关闭 GC。',
  keepTurnsLabel: '每个会话保留的回合数',
  keepTurnsDescription:
    '每次提交回合后，这个会话的回合数超过此值就删除最早的几轮（连同备份），只能回滚最近这么多轮；没改文件、只有对话的回合也算一轮。设为 0 不限。',
  coverageLabel: '记检查点的会话',
  coverageDescription:
    '哪些会话的回合建检查点（回滚靠它）。「按受众」只在受众只有你的会话里记：WebUI、终端与你自己的 IM 私聊；群与别人的私聊不记，你从 WebUI 发进群的那一轮也不记。',
  coverageOff: '不记',
  coverageOwnerOnly: '按受众（只有你时记）',
  coverageAll: '记',
  rootDirNotUri: 'plugin-checkpoint 配置错误：rootDir 不是 storage URI，请写成 <根名>:/<路径>',
  clearType: '检查点（对话回滚存档）',
  clearedAll: '所有 checkpoint 已清空（{count, number} 个 session）',
  clearedSession: '当前会话 checkpoint 已清空（{count, number} 个 turn）',
  noneInSession: '当前会话无 checkpoint',
  clearFailed: 'checkpoint 清空失败：{error}',
  notSnapshotUnreadable: '未快照（原文件读取失败，不可回滚）',
  notSnapshotDirectory: '未快照（目录或读取失败）',
  tooLarge: '文件过大 ({size} > {max})',
  noCheckpoint: 'checkpoint 不存在',
  noDeleteByTimestamps: '当前 memory 后端不支持 deleteMessagesByTimestamps',
  deleteMessagesFailed: '删除消息失败：{error}',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-checkpoint', language: 'zh-CN', source: SOURCE, locales: { en } });
