// 本插件自己的原文字典：计划任务页的保存回执与拒写期间的附注（附注与 scheduler_create_job 共用，工具取原文）
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  jobSaved: '已保存任务 {name}',
  notPersisted: '仅本次运行生效，未写入 {uri}：它读不出来，处理办法见「需要处理」里的提示',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-scheduler', language: 'zh-CN', source: SOURCE, locales: { en } });
