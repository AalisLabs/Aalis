import type {} from '@aalis/api-llm';
import { type ConfigOf, defineConfig } from '@aalis/schema-config';
import { t } from './texts.js';

export const configSchema = defineConfig({
  reviewEnabled: {
    type: 'boolean',
    label: t('reviewEnabledLabel'),
    default: true,
    onInvalid: 'error',
    description: t('reviewEnabledDescription'),
  },
  manualReview: {
    type: 'boolean',
    label: t('manualReviewLabel'),
    default: false,
    onInvalid: 'error',
    description: t('manualReviewDescription'),
  },
  ownerTimeoutHours: { type: 'number', label: t('ownerTimeoutHoursLabel'), default: 12, min: 1, max: 168 },
  ffmpegPath: {
    type: 'string',
    label: t('ffmpegPathLabel'),
    description: t('ffmpegPathDescription'),
    default: 'ffmpeg',
    // 必填加默认值：留空时用默认的命令名，不会拿空串去执行
    required: true,
    format: 'executable',
    onInvalid: 'error',
  },
  chrome: {
    type: 'group',
    label: t('chromeLabel'),
    fields: {
      headless: { type: 'boolean', label: t('headlessLabel'), default: true },
      executablePath: {
        type: 'string',
        label: t('executablePathLabel'),
        default: '',
        format: 'absolute-path',
        onInvalid: 'error',
      },
    },
  },
  textClassifier: { type: 'llm-ref', label: t('textClassifierLabel') },
  imageClassifier: { type: 'llm-ref', label: t('imageClassifierLabel'), description: t('imageClassifierDescription') },
  limits: {
    type: 'group',
    label: t('limitsLabel'),
    fields: {
      maxFileMB: { type: 'number', label: t('maxFileMBLabel'), default: 25, min: 1, max: 25, onInvalid: 'error' },
      maxWorkFiles: {
        type: 'number',
        integer: true,
        label: t('maxWorkFilesLabel'),
        default: 50,
        min: 1,
        max: 50,
        onInvalid: 'error',
      },
      maxWorkMB: { type: 'number', label: t('maxWorkMBLabel'), default: 50, min: 1, max: 50, onInvalid: 'error' },
      maxPending: {
        type: 'number',
        integer: true,
        label: t('maxPendingLabel'),
        default: 20,
        min: 1,
        max: 1000,
        onInvalid: 'error',
      },
      maxPendingPerOrigin: {
        type: 'number',
        integer: true,
        label: t('maxPendingPerOriginLabel'),
        default: 3,
        min: 1,
        max: 1000,
        onInvalid: 'error',
      },
      maxDailyPerOrigin: {
        type: 'number',
        integer: true,
        label: t('maxDailyPerOriginLabel'),
        default: 10,
        min: 1,
        max: 10000,
        onInvalid: 'error',
      },
    },
  },
});

export type ReviewConfig = ConfigOf<typeof configSchema>;
