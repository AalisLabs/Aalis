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
    'Maximum run time of the transcoding and recognition subprocesses; they are stopped when it runs out. 10 minutes by default. With 0 (no limit), a stuck subprocess blocks the whole turn.',
});
