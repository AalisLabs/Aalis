import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Whisper.cpp local transcription',
  binaryPathLabel: 'whisper-cli path',
  binaryPathDescription: 'An absolute path, or a command name found on PATH.',
  modelPathLabel: 'Model file path (.bin)',
  modelPathDescription: 'Absolute path of the GGML model file (.bin).',
  languageLabel: 'Default language',
  threadsLabel: 'Threads',
  timeoutMsLabel: 'Subprocess timeout (ms)',
  timeoutMsDescription:
    'Maximum run time of the transcoding and recognition subprocesses. This limit is there to cut off subprocesses that are truly stuck, not to throttle recognition — long audio is slow on a CPU anyway, so the default is 10 minutes. 0 means no limit (a stuck subprocess will then hang the whole turn with it).',
});
