import { type ConfigOf, defineConfig } from '@aalis/schema-config';
import { t } from './texts.js';

export const configSchema = defineConfig({
  rootDir: {
    type: 'string',
    label: t('rootDirLabel'),
    onInvalid: 'error',
    description: t('rootDirDescription'),
    default: 'data:/checkpoints',
  },
  maxFileSize: {
    type: 'number',
    label: t('maxFileSizeLabel'),
    description: t('maxFileSizeDescription'),
    default: 10 * 1024 * 1024,
  },
  keepSessions: {
    type: 'number',
    label: t('keepSessionsLabel'),
    description: t('keepSessionsDescription'),
    default: 20,
  },
  keepTurns: {
    type: 'number',
    label: t('keepTurnsLabel'),
    description: t('keepTurnsDescription'),
    default: 200,
  },
  // 按会话字段：在哪一层读都是字面意思，在某个群的场所层选「记」就是这个群记
  coverage: {
    type: 'select',
    label: t('coverageLabel'),
    description: t('coverageDescription'),
    default: 'ownerOnly',
    options: [
      { label: t('coverageOff'), value: 'off' },
      { label: t('coverageOwnerOnly'), value: 'ownerOnly' },
      { label: t('coverageAll'), value: 'all' },
    ],
    session: { prominence: 'advanced' },
  },
});

export type CheckpointConfig = ConfigOf<typeof configSchema>;
