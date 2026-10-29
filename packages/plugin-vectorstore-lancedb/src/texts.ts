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
  optimizeEveryDescription:
    '每写入多少条向量后后台压实一次（合并碎片 + 回收作废数据文件）。LanceDB 每次 add 产生一个新碎片与版本，不压实会让 data/ 与 _versions/ 无界膨胀、写入越来越慢；设 0 关闭',
  cleanupRetentionMinutesLabel: '数据文件保留窗（分钟）',
  cleanupRetentionMinutesDescription:
    '压实时回收「此分钟数以前」的作废数据文件。比它更新的文件（含可能在途的写入）一律保留，故对单进程写入安全。默认 LanceDB 保留 7 天，高频压实下会让 data/ 累到数百 GB —— 收紧到分钟级即可把库压回真实大小。调大更保守、更占盘。',
  tableNameEmpty: 'tableName 不能为空',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-vectorstore-lancedb',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
