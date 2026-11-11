// 本插件自己的原文字典：显示名、配置项、配置报错与连接失败
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: 'MongoDB 记忆',
  uriDescription: 'MongoDB 连接字符串（可能带账号密码，存进 secrets.yaml，WebUI 不回显）',
  databaseLabel: '数据库名',
  databaseDescription:
    '存消息历史的数据库名。留空时按数据目录与实例自动命名（如 aalis、aalis_<profile>）；同一连接下的两个实例不能共用一个库。',
  claimFromLabel: '认领库的归属',
  claimFromDescription:
    '平时留空。库已归另一个数据目录时，先停掉那边的实例，再填它的路径；库里有数据却没有归属记录时填 unowned。启动一次即完成认领，之后删掉这一项。',
  collectionLabel: '集合名',
  collectionDescription: '消息集合名称',
  connectTimeoutMsLabel: '连接超时（毫秒）',
  connectTimeoutMsDescription: '建立连接与服务器选择（serverSelection）的超时时间，两者共用此值',
  rangeQueryLimitLabel: '范围查询返回上限',
  rangeQueryLimitDescription: '区间消息查询（向量召回的上下文窗口扩展等）单次返回的最大条数。命中上限会静默截断',
  crossSessionMaxLimitLabel: '跨会话查询返回上限',
  crossSessionMaxLimitDescription: '跨会话最近消息查询允许的最大条数；调用方请求超过此值会被收窄到此上限',
  databaseTooLong: 'MongoDB 库名 {database} 超过 63 字节的上限：请给 {instance} 另配一个短些的 database',
  databaseInUse:
    'MongoDB 库 {database} 已被实例 {holder} 使用（同一连接串），两个实例不能共用一个库：请给 {instance} 另配 database',
  connectFailed: 'MongoDB 连接失败（确认 MongoDB 在运行、配置项 uri 写对）：{error}',
  unownedData:
    'MongoDB 库 {database} 里已有数据，但没有记录它归哪个数据目录。若这就是本数据目录的数据，在 {instance} 的配置里写 claimFrom: unowned 后重启认领；否则给它另配 database',
  ownerRecordBroken:
    'MongoDB 库 {database} 的归属记录坏了（metadata 集合里命名空间 {namespace}、键 {key} 的那条缺数据目录或实例）。确认这是本数据目录的数据后，在 {instance} 的配置里写 claimFrom: unowned 后重启认领；否则给它另配 database',
  ownedBySibling:
    'MongoDB 库 {database} 归本数据目录的实例 {owner}，两个实例不能共用一个库：请给 {instance} 另配 database。若是实例改了名、要把库转给 {instance}，先停掉 {owner}，再写 claimFrom: {dir} 后重启认领',
  ownedByOtherDataDir:
    'MongoDB 库 {database} 已归数据目录 {dir}（实例 {owner}）。若本数据目录是从那里搬来的，先停掉那个数据目录的实例，再在 {instance} 的配置里写 claimFrom: {dir} 后重启认领；否则给它另配 database',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-memory-mongodb',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
