// 本包自己的原文字典：未启动的原因（缺、在等）与 core 自己的失败的说明
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  lacking: '缺少服务 {service}（{trace}）',
  failed: '{path} 失败：{reason}',
  reasonInLog: '原因见日志',
  disabled: '{path} 已停用',
  starting: '等待 {instance} 启动',
  lingering: '等待 {instance} 的旧实例停下',
  withdrawn: '{path} 在运行但没有提供 {service}',
  unprovided: '没有已装的插件提供',
  unprovidedVia: '{path} → 没有已装的插件提供 {service}',
  cycle: '互相等待成环：{instances, list}',
  cycleVia: '{path} → 互相等待成环：{instances, list}',
  retryExhausted:
    '初始化期间 required 依赖反复缺失（最后一次缺 {service}），自动重试未收敛，已停止；重新启用或重载后重试',
  providesNotRegistered: '声明提供 {services, list}，但激活完成时没有登记这些服务',
  exclusiveConflict: '服务 {service} 为独占登记，不能再添加提供者',
  unavailable: '服务 {service} 当前没有提供者',
  unavailableFrom: '服务 {service} 的提供者 {provider} 当前不可用',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/api-doctor', language: 'zh-CN', source: SOURCE, locales: { en } });
