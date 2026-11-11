// 本插件自己的原文字典：显示名、工具分组名与概述，插件配置与按会话字段「子任务模型」的称呼与说明
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '子任务',
  groupLabel: '子任务管理',
  groupSummary: '创建、管理和协调子任务会话，支持并行执行',
  enabledLabel: '启用子任务工具',
  maxWaitMsLabel: '单次等待最大时长 (ms)',
  modelLabel: '子任务模型',
  modelDescription: '派子任务时子会话用的模型，按派它的会话取，能按群设；create_subtask 的 model 参数压过它',
  modelUnset: '不另指定（与本会话相同）',
  idleLabel: '交回后闲置销毁（小时）',
  idleDescription:
    '子会话一轮结束后这么久没有追问，就连同对话记录销毁，每次追问重新计时。0 即交回结果后立即销毁；有后台任务在运行时不销毁',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-subtask', language: 'zh-CN', source: SOURCE, locales: { en } });
