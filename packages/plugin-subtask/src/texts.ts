// 本插件自己的原文字典：按会话字段「子任务模型」与插件配置「交回后闲置销毁」的称呼与说明
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  modelLabel: '子任务模型',
  modelDescription: '派子任务时子会话用的模型，按派它的会话取，能按群设；create_subtask 的 model 参数压过它',
  modelUnset: '不另指定（与本会话相同）',
  idleLabel: '交回后闲置销毁（小时）',
  idleDescription:
    '子会话的一轮结束（回复、出错或被停止）后这么久没有追问，就连同对话记录销毁，追问一次重新计时；0 即交回结果立即销毁',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-subtask', language: 'zh-CN', source: SOURCE, locales: { en } });
