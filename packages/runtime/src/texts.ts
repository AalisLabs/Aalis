// 本包自己的原文字典：经 WebUI 显示的拒写说明、配置文档的报错与诊断项 config.secrets，以及文件称呼与 YAML 报错位置。
// 后两样也用在日志（取原文）与启动时打到终端的报错（取英文），三处共用一份。其余插件加载之前与插件体系之外打到终端的话
// 不进字典，直接写英文
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  configFile: '配置文件',
  secretsFile: '密钥文件',
  yamlSyntax: '语法错误',
  yamlPosition: '{code}（第 {line} 行第 {col} 列）',
  saveRefused: '{file}有尚未生效的外部修改，为免覆盖已拒绝本次保存（{path}）',
  unsafePluginId: '插件 id 不合法：{id}',
  noDefinition: '插件 {instance} 不存在，也没有可用来新建它的同模块定义（模块须已登记且声明 reusable）',
  plainSecret:
    'setPluginConfig 只收文档形态：{instance} 的 {paths, list} 是密钥字段，不能写原值；改配置请用 applyPluginConfig',
  secretAt: '{path}（键 {key}）',
  danglingRejected:
    '{instance} 引用的密钥不在 secrets.yaml 里：{items, list}；重新填写值，或先在 secrets.yaml 里补上这些键',
  dangling:
    '{instance} 引用的密钥不在 secrets.yaml 里：{items, list}；用 parseConfig 读配置的插件会激活失败，在 WebUI 重新填写或在 secrets.yaml 里补上这些键',
  secretsResolved: '配置引用的密钥都在 secrets.yaml 里',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/runtime', language: 'zh-CN', source: SOURCE, locales: { en } });
