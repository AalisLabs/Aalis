// 本插件自己的原文字典：显示名、配置项与开库失败（插件失败原因）
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: 'SQLite 记忆',
  pathLabel: '数据库路径',
  pathDescription:
    "SQLite 数据库文件的 storage URI（如 data:/aalis.db；不含 ':/' 时首段视为存储根名，单段裸名归 data 根）。留空按实例派生：主实例用 data:/aalis.db，带后缀的实例在文件名上加后缀（如 `:b` 实例用 data:/aalis-b.db）。两个实例不能用同一个库，后激活的那个会报配置错误",
  rangeQueryLimitLabel: '范围查询返回上限',
  rangeQueryLimitDescription: '区间消息查询（向量召回的上下文窗口扩展等）单次返回的最大条数。命中上限会静默截断',
  crossSessionMaxLimitLabel: '跨会话查询返回上限',
  crossSessionMaxLimitDescription: '跨会话最近消息查询允许的最大条数；调用方请求超过此值会被收窄到此上限',
  pathUnresolvable: '无法解析数据库路径 {uri}（检查配置项 path）：{error}',
  nodeTooOld:
    'SQLite 打开失败：当前 Node（{version}）版本过低，需要 Node 24.15.0 起；升级方法见 https://aalis.acenyan.com/guide/first-run#upgrade-node',
  openFailedDir: 'SQLite 打开失败（检查目录 {dir} 存在且可写，或在配置项 path 换个位置）：{error}',
  sharedDb: '数据库文件 {path} 已被实例 {holder} 使用，两个实例不能共用一个库：请给 {instance} 另配 path',
  sharedDbVia:
    '数据库文件 {path} 已被实例 {holder} 使用（经路径 {via} 打开），两个实例不能共用一个库：请给 {instance} 另配 path',
  openFailed: 'SQLite 打开失败：{error}',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-memory-sqlite', language: 'zh-CN', source: SOURCE, locales: { en } });
