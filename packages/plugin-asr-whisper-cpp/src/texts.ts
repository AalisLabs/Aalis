// 本插件自己的原文字典：显示名与配置项
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: 'Whisper.cpp 本地转写',
  binaryPathLabel: 'whisper-cli 路径',
  binaryPathDescription: '绝对路径，或 PATH 里能找到的命令名。',
  modelPathLabel: '模型文件路径 (.bin)',
  modelPathDescription: 'GGML 模型文件（.bin）的绝对路径。',
  languageLabel: '默认语种',
  threadsLabel: '线程数',
  timeoutMsLabel: '子进程超时 (ms)',
  timeoutMsDescription:
    '转码与识别子进程的最长运行时间。这道闸是为了掐断真正卡死的子进程，不是为了给识别限速——CPU 上跑长语音本来就慢，默认给到 10 分钟。设 0 表示不限（届时卡住的子进程会把整轮对话一起挂住）。',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({
  ns: '@aalis/plugin-asr-whisper-cpp',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en },
});
