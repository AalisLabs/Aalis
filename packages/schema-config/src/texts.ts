// 本包自己的原文字典：核心配置表单、校验原因与配置错误
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  nameLabel: '应用名称',
  nameDescription: '应用显示名称，用于启动日志和界面展示',
  logLevelLabel: '日志等级',
  logLevelDescription: '日志输出等级',
  slowThresholdLabel: '慢操作阈值（毫秒）',
  slowThresholdDescription:
    '插件激活超过它仍未完成时告警并转入后台继续（它提供的服务在激活完成前不对依赖方开放），app 启动与停机阶段的单个事件监听器超过它时告警并不再等待；0 表示不设限；重启生效',
  missing: '必填字段缺失',
  expectedGroup: '期望对象（分组），得到 {got}',
  expectedArray: '期望数组，得到 {got}',
  expectedItem: '期望对象元素，得到 {got}',
  expectedString: '期望 string，得到 {got}',
  expectedNumber: '期望有限数值，得到 {got}',
  expectedBoolean: '期望 boolean，得到 {got}',
  expectedChoice: '期望 string 或 number，得到 {got}',
  expectedChoiceItem: '期望 string 或 number 元素，得到 {got}',
  expectedStringItem: '期望 string 元素，得到 {got}',
  expectedMap: '期望对象（映射），得到 {got}',
  expectedStringValue: '期望 string 值，得到 {got}',
  notGroup: '期望对象（分组）',
  notArray: '期望数组',
  notItem: '期望对象元素',
  integer: '期望整数',
  min: '小于下限 {min}',
  max: '大于上限 {max}',
  pattern: '不匹配模式 {pattern}',
  patternHidden: '不匹配模式',
  notOption: '不是可选值（{options, list}）之一',
  notOptionHidden: '不是可选值',
  absolutePath: '须为绝对路径',
  executable: '须为绝对路径或命令名（不含路径分隔符）',
  reservedKey: '保留键不可用',
  secretUnresolved: '引用的密钥 {key} 不在宿主的密钥存储里',
  validateFailed: '{reason}',
  validateError: '校验时出错',
  notObject: '配置整体期望对象，在 WebUI 或配置文件中改正后生效',
  invalid: '配置项 {path} {reason}，在 WebUI 或配置文件中改正后生效',
  missingField: '缺少配置项 {field}，在 WebUI 或配置文件中填入后生效',
  missingFieldNote: '缺少配置项 {field}（{note}），在 WebUI 或配置文件中填入后生效',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/schema-config', language: 'zh-CN', source: SOURCE, locales: { en } });
