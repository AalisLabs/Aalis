// 本包自己的原文字典：落盘失败的说法
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  notWritten:
    '已在运行态生效，但未写入配置文件（{error}）；{reconcile, select, reload {修好该文件后会按文件内容重载} other {修好该文件后，重启时以文件内容为准}}',
  writeFailed: '已在运行态生效，但写入配置文件失败（{error}）；改动保留在文档里，下次保存成功时一并写入',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/api-host-config', language: 'zh-CN', source: SOURCE, locales: { en } });
