import type {} from '@aalis/api-llm';
import { type ConfigOf, defineConfig } from '@aalis/schema-config';

export const configSchema = defineConfig({
  reviewEnabled: {
    type: 'boolean',
    label: '启用内容审核',
    default: true,
    onInvalid: 'error',
    description: '关闭时跳过内容标记、模型分类和人工裁决；文件格式、大小、路径、元数据处理及发布完整性校验仍执行。',
  },
  manualReview: {
    type: 'boolean',
    label: '每件作品均需人工审核',
    default: false,
    onInvalid: 'error',
    description:
      '内容审核启用时，开启后每件作品须经人工批准。关闭时自动通过即可发布；自动拒绝、拿不准或模型不可用时仍会拦截并转人工。文件处理失败须先修复。',
  },
  ownerTimeoutHours: { type: 'number', label: '人工审核等待时限（小时）', default: 12, min: 1, max: 168 },
  ffmpegPath: { type: 'string', label: 'ffmpeg 路径', default: 'ffmpeg', onInvalid: 'error' },
  chrome: {
    type: 'group',
    label: '离线渲染浏览器',
    fields: {
      headless: { type: 'boolean', label: '无头模式', default: true },
      executablePath: { type: 'string', label: '浏览器路径', default: '' },
    },
  },
  textClassifier: { type: 'llm-ref', label: '文本审核模型' },
  imageClassifier: { type: 'llm-ref', label: '图像审核模型', description: '留空使用文本审核模型，必须支持图像。' },
  limits: {
    type: 'group',
    label: '审核队列上限',
    fields: {
      maxFileMB: { type: 'number', label: '单文件 MiB', default: 25, min: 1, max: 25, onInvalid: 'error' },
      maxWorkFiles: {
        type: 'number',
        integer: true,
        label: '每件作品文件数',
        default: 50,
        min: 1,
        max: 50,
        onInvalid: 'error',
      },
      maxWorkMB: { type: 'number', label: '每件作品总 MiB', default: 50, min: 1, max: 50, onInvalid: 'error' },
      maxPending: {
        type: 'number',
        integer: true,
        label: '待审总数',
        default: 20,
        min: 1,
        max: 1000,
        onInvalid: 'error',
      },
      maxPendingPerOrigin: {
        type: 'number',
        integer: true,
        label: '每来源待审数',
        default: 3,
        min: 1,
        max: 1000,
        onInvalid: 'error',
      },
      maxDailyPerOrigin: {
        type: 'number',
        integer: true,
        label: '每来源每日提名数',
        default: 10,
        min: 1,
        max: 10000,
        onInvalid: 'error',
      },
    },
  },
});

export type ReviewConfig = ConfigOf<typeof configSchema>;
