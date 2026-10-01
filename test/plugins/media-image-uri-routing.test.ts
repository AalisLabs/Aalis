import { afterEach, describe, expect, it } from 'vitest';
import { setMediaRuntime } from '../../packages/plugin-media/src/runtime.js';
import { resolveImageStorageUri } from '../../packages/plugin-media/src/tools.js';

// ════════════════════════════════════════════════════════════
// 图片来源的裸相对路径按首段路由到存储根（data/images/x.jpg → data:/images/x.jpg）。
// 插件私有的内置根（人设卡、技能、编排定义、缓存、日志、插件数据、白纸、公开作品）不参与：
// 工作目录里与它们同名的子目录（skills/x.png）照常归到 workspace。
// ════════════════════════════════════════════════════════════

const roots = [
  ['workspace', 'workspace'],
  ['data', 'data'],
  ['tmp', 'tmp'],
  ['project', 'custom'],
  ['skills', 'self'],
  ['cache', 'cache'],
  ['logs', 'logs'],
  ['pluginData', 'pluginData'],
  ['paper', 'paper'],
  ['public', 'public'],
].map(([name, kind]) => ({ name, kind }));

describe('resolveImageStorageUri', () => {
  afterEach(() => {
    setMediaRuntime({ proc: {} as never, storage: {} as never });
  });

  it('首段是 data、tmp 与用户根时路由过去，插件私有的内置根不参与，其余归 workspace', () => {
    setMediaRuntime({ proc: {} as never, storage: { listRoots: () => roots } as never });
    expect(resolveImageStorageUri('data/images/x.jpg')).toBe('data:/images/x.jpg');
    expect(resolveImageStorageUri('tmp/shot.png')).toBe('tmp:/shot.png');
    expect(resolveImageStorageUri('project/a.png')).toBe('project:/a.png');
    for (const name of ['skills', 'cache', 'logs', 'pluginData', 'paper', 'public']) {
      expect(resolveImageStorageUri(`${name}/x.png`), name).toBe(`workspace:/${name}/x.png`);
    }
    expect(resolveImageStorageUri('pics/x.png')).toBe('workspace:/pics/x.png');
    expect(resolveImageStorageUri('skills:/x.png')).toBe('skills:/x.png');
  });
});
