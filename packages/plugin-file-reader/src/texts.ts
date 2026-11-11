// 本插件自己的原文字典：显示名、配置项与配置报错，会话面板「上传的文件」的文字、类型一列「文本」「未知」的显示名、动作回执与
// 报错，工具分组名与概述
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '文件读取',
  maxFileSizeMBLabel: '最大文件大小 (MB)',
  maxFileSizeMBDescription: '允许上传的最大文件大小（MB）。超过此限制的文件将被拒绝。',
  autoInlineLimitLabel: '自动内联阈值（字符）',
  autoInlineLimitDescription:
    '提取出的文本不超过这个长度时直接附进消息，模型不用调工具就能看到全文；更长的只给文件 ID，由模型按需读取。有别人在场的会话一律不附全文。',
  toolDefaultMaxLengthLabel: 'read_uploaded_file 默认截断',
  toolDefaultMaxLengthDescription:
    '读取上传文件的工具没指定长度时最多返回多少字符，0 为不截断；须为非负整数，否则报配置错误。',
  badToolDefaultMaxLength: 'toolDefaultMaxLength 要是非负整数（0 表示不截断）',
  retentionDaysLabel: '保留天数',
  retentionDaysDescription: '上传文件保留的最长天数，超过即清理（按上传时间 uploadedAt）。0 表示不按时间清理。',
  lruMaxTotalMBLabel: '磁盘总量上限 (MB)',
  lruMaxTotalMBDescription:
    '上传文件总目录占用超过该上限时，按上传时间 uploadedAt 由旧到新淘汰直到回落到上限以下。0 表示不限。',
  historyHintEnabledLabel: '注入会话文件清单提示',
  historyHintEnabledDescription:
    '开启后，会话里有上传过的文件时，在调用模型前提示可用的文件及 ID，本轮新上传的单独标出。只列最近 {count, number} 个。',
  recognizeDocImagesLabel: '识别文档内嵌图片',
  recognizeDocImagesDescription:
    '读取 DOCX 时识别内嵌图片，把描述附在正文末尾；需要识图功能，没有时跳过。会增加首次解析的耗时与识图开销。',
  maxDocImagesLabel: '单文档最多识别图片数',
  maxDocImagesDescription: '超出的内嵌图片跳过识别，避免大量图片拖慢解析、增加识图开销。0 等同关闭识别。',
  uploads: '上传的文件',
  delete: '删除',
  deleteConfirm: '删除这个上传的文件？之后模型就读不到它了。',
  notInSession: '本会话没有这个文件',
  deleted: '已删除 {name}',
  deleteFailed: '删除 {name} 失败：{error}',
  noUploads: '本会话没有上传的文件',
  fileName: '文件名',
  size: '大小（字节）',
  format: '类型',
  uploadedAt: '上传时间',
  formatText: '文本',
  formatUnknown: '未知',
  groupLabel: '删除上传的文件',
  groupSummary: '删除用户上传的文件',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-file-reader',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
