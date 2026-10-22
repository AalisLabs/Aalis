import { describe, expect, it } from 'vitest';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import type { CwdState } from '../../packages/plugin-tool-system/src/tools/cwd-state.js';
import { registerSystemTools } from '../../packages/plugin-tool-system/src/tools/system.js';
import { defineTexts } from '../../packages/schema-i18n/src/index.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';

// ════════════════════════════════════════════════════════════
// cwd 工具交给模型的存储根清单：根的展示名可以是文字对象（存储根的登记方给的），交给模型的取原文
// ════════════════════════════════════════════════════════════

const t = defineTexts({
  ns: '@zz/tool-system-roots',
  language: 'zh-CN',
  source: { workspace: '工作区' } as const,
  locales: { en: { workspace: 'Workspace' } },
});

describe('cwd 工具的存储根清单', () => {
  it('根的展示名是文字对象：交给模型的是原文', async () => {
    const handlers = new Map<string, RegisteredTool['handler']>();
    const storage = {
      listRoots: () => [
        {
          name: 'workspace',
          label: t('workspace'),
          kind: 'workspace',
          browsable: true,
          readable: true,
          writable: true,
          deletable: false,
        },
      ],
    } satisfies Pick<StorageService, 'listRoots'>;
    const cwdState = { get: () => 'workspace:/', getInitial: () => 'workspace:/' };
    registerSystemTools(
      stubBoundTools({ onRegister: tool => handlers.set(tool.definition.function.name, tool.handler) }),
      { cwdState: cwdState as unknown as CwdState, storage: storage as StorageService },
    );
    const cwd = handlers.get('cwd');
    if (!cwd) throw new Error('cwd 工具未登记');
    const out = JSON.parse(String(await cwd({}, { sessionId: 'zz', platform: 'webui' })));
    expect(out.availableRoots).toEqual([
      {
        name: 'workspace',
        uri: 'workspace:/',
        label: '工作区',
        kind: 'workspace',
        readable: true,
        writable: true,
        deletable: false,
      },
    ]);
  });
});
