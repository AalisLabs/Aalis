// 本插件自己的原文字典：显示名、配置项、配置报错与连接失败
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: 'MongoDB 记忆',
  uriDescription: 'MongoDB 连接字符串（可能带账号密码，存进 secrets.yaml，WebUI 不回显）',
  databaseLabel: '数据库名',
  databaseDescription:
    '存储消息历史与元数据（固定名为 metadata 的集合）的数据库。留空按家目录与实例派生：主家目录用 aalis，profile 家目录（部署目录下的 data-<profile>）用 aalis_<profile>；带后缀的实例再加后缀（如 `:b` 实例用 aalis-b、aalis_<profile>_b）。同一连接串下两个实例不能用同一个库，后激活的那个会报配置错误；库里记着它归哪个家目录，别的家目录连上来也会报错',
  claimFromLabel: '认领库的归属',
  claimFromDescription:
    '平时留空。库已归另一个家目录（例如家目录搬了位置）时，先停掉那个家目录的实例，再填它的路径；库里已有数据却还没有归属记录时填 unowned。启动一次就把归属改到这个家目录，认领后删掉这一项：留着的 unowned 会让以后指向的任何库都跳过「已有数据」的检查',
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
    'MongoDB 库 {database} 里已有数据，但没有记录它归哪个家目录。若这就是本家目录的数据，在 {instance} 的配置里写 claimFrom: unowned 后重启认领；否则给它另配 database',
  ownerRecordBroken:
    'MongoDB 库 {database} 的归属记录坏了（metadata 集合里命名空间 {namespace}、键 {key} 的那条缺家目录或实例）。确认这是本家目录的数据后，在 {instance} 的配置里写 claimFrom: unowned 后重启认领；否则给它另配 database',
  ownedBySibling:
    'MongoDB 库 {database} 归本家目录的实例 {owner}，两个实例不能共用一个库：请给 {instance} 另配 database。若是实例改了名、要把库转给 {instance}，先停掉 {owner}，再写 claimFrom: {home} 后重启认领',
  ownedByOtherHome:
    'MongoDB 库 {database} 已归家目录 {home}（实例 {owner}）。若本家目录是从那里搬来的，先停掉那个家目录的实例，再在 {instance} 的配置里写 claimFrom: {home} 后重启认领；否则给它另配 database',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-memory-mongodb',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
