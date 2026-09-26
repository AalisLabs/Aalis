import { describe, expect, it } from 'vitest';
import { CheckpointServiceImpl } from '../../packages/plugin-checkpoint/src/service.js';

// 读 checkpoint 失败时，「不存在」之外的原因要留痕：storage 不在线、权限被拒（EACCES）、manifest 半写损坏
// 都曾被当成「不存在」——回滚只报「checkpoint 不存在」，坏回合从列表里静默消失，日志里什么都没有。
// 仍返回空结果而不是抛出：listTurns 逐个读 manifest，一个坏回合不能拖垮整张列表。

const ROOT = 'ws:/checkpoints';

function errno(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * readFile 按 URI 查表：字符串是文件内容，Error 是读取时抛出的错误（测试可中途改表）；list 返回 turns，
 * 或抛 listError（可经 setListError 中途切换）
 */
function makeService(files: Record<string, string | Error>, turns: string[], listError?: Error) {
  const warns: string[] = [];
  const storage = {
    readFile: async (uri: string) => {
      const hit = files[uri];
      if (hit === undefined) throw errno('ENOENT', `ENOENT: no such file, open '${uri}'`);
      if (hit instanceof Error) throw hit;
      return Buffer.from(hit);
    },
    list: async () => {
      if (listError) throw listError;
      return { entries: turns.map(name => ({ name, isDirectory: true, uri: `${ROOT}/s1/${name}` })) };
    },
    listRoots: () => [{ name: 'ws', kind: 'workspace' }],
  };
  const logger = { debug() {}, info() {}, warn: (msg: string) => void warns.push(msg), error() {} };
  const cfg = { rootUri: ROOT, maxFileSize: 1024, keepSessions: 0, scopes: ['*'] };
  const svc = new CheckpointServiceImpl(cfg, logger as never, storage as never);
  const setListError = (err: Error | undefined) => {
    listError = err;
  };
  return { svc, warns, setListError };
}

const manifestUri = (turnId: string) => `${ROOT}/s1/${turnId}/manifest.json`;
const manifest = (turnId: string) =>
  JSON.stringify({ turnId, sessionId: 's1', startedAt: 1, endedAt: 2, files: [], messageTimestamps: [] });

describe('checkpoint 读取失败的留痕', () => {
  it('manifest 不存在：返回 null，不告警', async () => {
    const { svc, warns } = makeService({}, []);
    expect(await svc.getManifest('s1', 't1')).toBeNull();
    expect(warns).toEqual([]);
  });

  it('manifest 权限被拒或损坏：返回 null 并点名 uri 与原因告警', async () => {
    const { svc, warns } = makeService(
      { [manifestUri('t1')]: errno('EACCES', 'EACCES: permission denied'), [manifestUri('t2')]: '{"turnId":' },
      [],
    );
    expect(await svc.getManifest('s1', 't1')).toBeNull();
    expect(await svc.getManifest('s1', 't2')).toBeNull();
    expect(warns).toHaveLength(2);
    expect(warns[0]).toContain(manifestUri('t1'));
    expect(warns[0]).toContain('EACCES');
    expect(warns[1]).toContain(manifestUri('t2'));
  });

  it('列表里一个坏 manifest 只跳过那一回合并告警，其余回合照常列出', async () => {
    const { svc, warns } = makeService(
      { [manifestUri('good')]: manifest('good'), [manifestUri('bad')]: errno('EACCES', 'EACCES: permission denied') },
      ['good', 'bad'],
    );
    expect((await svc.listTurns('s1')).map(t => t.turnId)).toEqual(['good']);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(manifestUri('bad'));
  });

  it('会话目录不存在：空列表，不告警', async () => {
    const { svc, warns } = makeService({}, [], errno('ENOENT', 'ENOENT: no such directory'));
    expect(await svc.listTurns('s1')).toEqual([]);
    expect(warns).toEqual([]);
  });

  it('列目录失败（storage 不在线、权限被拒）：空列表并告警', async () => {
    const { svc, warns } = makeService({}, [], new Error('未知存储根: ws'));
    expect(await svc.listTurns('s1')).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(`${ROOT}/s1`);
    expect(warns[0]).toContain('未知存储根');
  });

  it('列目录一直失败（storage 不在线）：同一原因只告警一次；恢复后再失败再记', async () => {
    const offline = new Error('未知存储根: ws');
    const { svc, warns, setListError } = makeService({ [manifestUri('t1')]: manifest('t1') }, ['t1'], offline);
    for (let i = 0; i < 3; i++) expect(await svc.listTurns('s1')).toEqual([]);
    expect(warns).toHaveLength(1);

    const denied = errno('EACCES', 'EACCES: permission denied');
    setListError(denied);
    await svc.listTurns('s1');
    expect(warns, '原因变了照记').toHaveLength(2);

    setListError(undefined);
    expect((await svc.listTurns('s1')).map(t => t.turnId)).toEqual(['t1']);
    setListError(denied);
    await svc.listTurns('s1');
    await svc.listTurns('s1');
    expect(warns, '恢复后再失败记一次').toHaveLength(3);
    expect(warns[2]).toContain('EACCES');
  });

  it('坏 manifest 反复列出只告警一次；修好后再坏再记', async () => {
    const files: Record<string, string | Error> = { [manifestUri('t1')]: '{"turnId":' };
    const { svc, warns } = makeService(files, ['t1']);
    await svc.listTurns('s1');
    await svc.listTurns('s1');
    expect(warns).toHaveLength(1);

    files[manifestUri('t1')] = manifest('t1');
    expect((await svc.listTurns('s1')).map(t => t.turnId)).toEqual(['t1']);
    files[manifestUri('t1')] = '{"turnId":';
    await svc.listTurns('s1');
    expect(warns).toHaveLength(2);
  });

  it('不同位置的失败各记各的', async () => {
    const denied = errno('EACCES', 'EACCES: permission denied');
    const { svc, warns } = makeService({ [manifestUri('a')]: denied, [manifestUri('b')]: denied }, ['a', 'b']);
    await svc.listTurns('s1');
    await svc.listTurns('s1');
    expect(warns).toHaveLength(2);
    expect(warns[0]).toContain(manifestUri('a'));
    expect(warns[1]).toContain(manifestUri('b'));
  });
});
