// 本插件自己的原文字典：显示名、配置项与配置报错，会话面板「上传的文件」的文字、类型一列「文本」「未知」的显示名、动作回执与
// 报错，工具分组名与概述
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '文件读取',
  maxFileSizeMBLabel: '最大文件大小 (MB)',
  maxFileSizeMBDescription: '允许上传的最大文件大小(MB)。超过此限制的文件将被拒绝。',
  autoInlineLimitLabel: '自动 inline 阈值（字符）',
  autoInlineLimitDescription:
    '提取出的文本长度若 ≤ 此值，则直接 inline 到附件描述里（模型无需调工具即可看到全文）；否则只挂 ID，由模型按需用 read_uploaded_file 拉取。受众里有别人的会话（群、多人房间、对端不是 owner 的私聊）里一律不内联，只给文件名、ID 与大小。',
  toolDefaultMaxLengthLabel: 'read_uploaded_file 默认截断',
  toolDefaultMaxLengthDescription:
    'read_uploaded_file 工具未显式传 maxLength 时使用的默认截断字符数，避免把超大文档一次喂进 LLM 上下文导致爆 token。0 表示不截断；要是非负整数，负数与小数报配置错误。',
  badToolDefaultMaxLength: 'toolDefaultMaxLength 要是非负整数（0 表示不截断）',
  retentionDaysLabel: '保留天数',
  retentionDaysDescription: '上传文件保留的最长天数，超过即清理（按上传时间 uploadedAt）。0 表示不按时间清理。',
  lruMaxTotalMBLabel: '磁盘总量上限 (MB)',
  lruMaxTotalMBDescription:
    '上传文件总目录占用超过该上限时，按上传时间 uploadedAt 由旧到新淘汰直到回落到上限以下。0 表示不限。',
  historyHintEnabledLabel: '注入会话文件清单提示',
  historyHintEnabledDescription:
    '开启后：会话中存在上传文件时，在 LLM 调用前注入一条 system 提示列出可用文件（含 ID），避免模型遗忘过往上传。本轮有新上传时注入本轮清单与历史清单（本轮文件单独标出），否则只注入历史清单。只列最近 {count, number} 个。',
  recognizeDocImagesLabel: '识别文档内嵌图片',
  recognizeDocImagesDescription:
    '读取 DOCX 时调用 media 服务识别内嵌图片，把描述附在正文末尾（需启用 media/vision；无 media 服务时自动跳过）。识别会增加首次解析耗时与 vision token 开销，结果随提取文本一并缓存。',
  maxDocImagesLabel: '单文档最多识别图片数',
  maxDocImagesDescription: '超出的内嵌图片跳过识别，避免大量图片拖慢解析、消耗 vision token。0 等同关闭识别。',
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
