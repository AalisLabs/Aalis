// 本插件自己的原文字典：显示名、配置项与配置报错
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: 'LanceDB 向量库',
  pathLabel: '数据库目录',
  pathDescription: 'LanceDB 数据存储 storage URI（也兼容裸名/相对路径）',
  tableNameLabel: '表名',
  tableNameDescription: '向量表名称',
  optimizeEveryLabel: '压实间隔',
  optimizeEveryDescription: '每写入多少条向量后在后台压实一次，合并碎片、回收作废的数据文件。设 0 关闭。',
  cleanupRetentionMinutesLabel: '数据文件保留窗（分钟）',
  cleanupRetentionMinutesDescription:
    '压实时回收多少分钟以前的作废数据文件，更新的文件一律保留。调大更保守，也更占磁盘。',
  tableNameEmpty: 'tableName 不能为空',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-vectorstore-lancedb',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
