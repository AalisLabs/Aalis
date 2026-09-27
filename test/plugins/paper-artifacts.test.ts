import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sniffType } from '../../packages/plugin-paper/src/artifacts.js';
import {
  DRIVER_CONFIG,
  type DriverHub,
  FAKE_TIMERS,
  PAPER_A_DIR,
  PAPER_A_ID,
  REMOTE_A,
  startDriverHub,
  stopDriverHubs,
  until,
} from '../fixtures/paper-driver.js';
import { GIF, JPEG, MP4, PNG, ScriptedRemote, text, WEBP } from '../fixtures/paper-remote.js';

// ════════════════════════════════════════════════════════════
// 成品的写入口（U10b）：提供者交来的相对路径再净化一次（不只信提供者），单文件、单轮总量、文件数与
// 白纸目录总占用都有上限；类型按文件头判定；落盘文件名由宿主生成（<产物 id>.<判定类型的扩展名>），
// 远端给的文件名只记在账本里供 WebUI 显示。
// ════════════════════════════════════════════════════════════

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKE_TIMERS.toFake], now: FAKE_TIMERS.now });
});
afterEach(async () => {
  await stopDriverHubs();
  vi.useRealTimers();
});

const KB = 1024;
const bytes = (n: number, head: Uint8Array = PNG) => {
  const out = new Uint8Array(n);
  out.set(head.subarray(0, Math.min(n, head.byteLength)));
  return out;
};

async function collect(hub: DriverHub, a: ScriptedRemote, files: Array<{ rel: string; data: Uint8Array }>) {
  const id = await hub.accept();
  await until(() => hub.task(id).state === 'running', '开轮');
  a.outputs.set(id, files);
  a.finish(hub.task(id).runId ?? '');
  await until(() => hub.task(id).state === 'done', '完成');
  return id;
}

function withArtifacts(artifacts: Record<string, number>) {
  return { ...DRIVER_CONFIG, artifacts };
}

describe('写入口', () => {
  it('安全：拒绝 ..、绝对路径、反斜杠、带 RLO 或控制字符的路径与超过单文件上限的文件；落盘文件名不含远端文件名', async () => {
    const a = new ScriptedRemote();
    const files = new Map();
    const hub = await startDriverHub({
      remotes: { [REMOTE_A]: a },
      files,
      config: withArtifacts({ maxFileMB: 1 / 1024 }),
    });
    const id = await collect(hub, a, [
      { rel: 'ok.png', data: PNG },
      { rel: 'fake.gif', data: PNG },
      { rel: 'SENTINEL-NAME.html', data: text('<!DOCTYPE html><title>x</title>') },
      { rel: 'sub/page.htm', data: text('﻿ \n <HTML lang="zh"></HTML>') },
      { rel: 'notes.html', data: text('hello') },
      { rel: 'clip.mp4', data: MP4 },
      { rel: '../escape.png', data: PNG },
      { rel: 'a/../../escape2.png', data: PNG },
      { rel: '/abs.png', data: PNG },
      { rel: 'dir\\win.png', data: PNG },
      { rel: 'evil‮gnp.exe', data: PNG },
      { rel: 'ctl\u0007.png', data: PNG },
      { rel: 'big.png', data: bytes(KB + 1) },
    ]);
    const artifacts = hub.task(id).artifacts;
    expect(artifacts.map(x => [x.rel, x.type])).toEqual([
      ['ok.png', 'png'],
      ['fake.gif', 'png'],
      ['SENTINEL-NAME.html', 'html'],
      ['sub/page.htm', 'html'],
      ['notes.html', 'other'],
      ['clip.mp4', 'mp4'],
    ]);
    const ext = { png: 'png', html: 'html', other: 'bin', mp4: 'mp4' } as Record<string, string>;
    const stored = [...files.keys()].filter(k => k.startsWith('paper:'));
    expect(stored.sort()).toEqual(artifacts.map(x => `${PAPER_A_DIR}/tasks/${id}/out/${x.id}.${ext[x.type]}`).sort());
    for (const x of artifacts) expect(x.id).toMatch(/^a-[0-9a-f]{8}$/);
    for (const key of stored) {
      expect(key).not.toContain('SENTINEL');
      expect(key).not.toContain('escape');
    }
    expect(files.get(`${PAPER_A_DIR}/tasks/${id}/out/${artifacts[1].id}.png`)).toEqual(PNG);
  });

  it('安全：单轮总量与文件数超限的被拒', async () => {
    const a = new ScriptedRemote();
    const total = await startDriverHub({
      remotes: { [REMOTE_A]: a },
      config: withArtifacts({ maxRunMB: 40 / (1024 * 1024) }),
    });
    const id = await collect(total, a, [
      { rel: '1.png', data: bytes(16) },
      { rel: '2.png', data: bytes(16) },
      { rel: '3.png', data: bytes(16) },
    ]);
    expect(total.task(id).artifacts.map(x => x.rel)).toEqual(['1.png', '2.png']);
    await total.stop();

    const b = new ScriptedRemote();
    const count = await startDriverHub({ remotes: { [REMOTE_A]: b }, config: withArtifacts({ maxRunFiles: 2 }) });
    const id2 = await collect(count, b, [
      { rel: '1.png', data: PNG },
      { rel: '2.png', data: PNG },
      { rel: '3.png', data: PNG },
    ]);
    expect(count.task(id2).artifacts.map(x => x.rel)).toEqual(['1.png', '2.png']);
  });

  it('工程包覆盖写 workspace.tar.gz，超过工程包上限的被拒', async () => {
    const a = new ScriptedRemote();
    const files = new Map();
    const hub = await startDriverHub({
      remotes: { [REMOTE_A]: a },
      files,
      config: withArtifacts({ maxBundleMB: 1 / 1024 }),
    });
    const first = await hub.accept();
    await until(() => hub.task(first).state === 'running', '开轮');
    const agentId = hub.task(first).agentId ?? '';
    a.bundles.set(agentId, text('bundle-v1'));
    a.finish(hub.task(first).runId ?? '');
    await until(() => hub.task(first).state === 'done', '完成');
    expect(files.get(`${PAPER_A_DIR}/workspace.tar.gz`)).toEqual(text('bundle-v1'));

    a.bundles.set(agentId, bytes(KB + 1));
    await collect(hub, a, []);
    expect(files.get(`${PAPER_A_DIR}/workspace.tar.gz`), '超限的工程包不覆盖旧的').toEqual(text('bundle-v1'));
  });

  it('安全：白纸目录已有占用加本轮成品超过 maxPaperMB 时，超出的与余下的文件被拒收，白纸停开并告警', async () => {
    const a = new ScriptedRemote();
    const files = new Map<string, string | Uint8Array>([
      [`${PAPER_A_DIR}/tasks/t-00000001/out/a-00000001.png`, bytes(80)],
    ]);
    const hub = await startDriverHub({
      remotes: { [REMOTE_A]: a },
      files,
      config: withArtifacts({ maxPaperMB: 104 / (1024 * 1024) }),
    });
    const id = await collect(hub, a, [
      { rel: '1.png', data: bytes(16) },
      { rel: '2.png', data: bytes(16) },
      { rel: '3.png', data: bytes(4) },
    ]);
    expect(hub.task(id).artifacts.map(x => x.rel)).toEqual(['1.png']);
    expect(hub.store.data.papers[PAPER_A_ID].halted?.reason).toBe('storage-full');
    expect(hub.store.data.alerts).toContainEqual(expect.objectContaining({ kind: 'storage-full' }));
    const refused = await hub.call('paper_task', { text: '再来一件', name: '再来' });
    expect(refused.ok).toBe(false);
  });
});

describe('按文件头判定类型', () => {
  it('位图与 MP4 看魔数，不看扩展名', () => {
    expect(sniffType('x.bin', PNG)).toBe('png');
    expect(sniffType('x.png', JPEG)).toBe('jpeg');
    expect(sniffType('x.jpg', GIF)).toBe('gif');
    expect(sniffType('x.gif', WEBP)).toBe('webp');
    expect(sniffType('x.txt', MP4)).toBe('mp4');
    expect(sniffType('x.png', text('not a png'))).toBe('other');
    expect(sniffType('x.png', new Uint8Array())).toBe('other');
  });

  it('HTML 须扩展名为 .html 或 .htm、能按 UTF-8 解码、去掉 BOM 与空白后以 <!doctype html 或 <html 开头', () => {
    expect(sniffType('index.html', text('<!doctype html><p>'))).toBe('html');
    expect(sniffType('INDEX.HTM', text('﻿\n\t <Html>'))).toBe('html');
    expect(sniffType('index.txt', text('<!doctype html>'))).toBe('other');
    expect(sniffType('index.html', text('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('other');
    expect(sniffType('index.html', new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0xff, 0xfe]))).toBe('other');
  });
});
