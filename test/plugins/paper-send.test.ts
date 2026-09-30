import { afterEach, describe, expect, it } from 'vitest';
import type { TaskRecord } from '../../packages/plugin-paper/src/ledger.js';
import {
  emptyLedger,
  human,
  LEDGER_URI,
  PAPER,
  type PaperFiles,
  PILOT_CONFIG,
  PILOT_ROOM,
  ROOM,
  ROOM2,
  startPaperHub,
  stopPaperHubs,
} from '../fixtures/paper.js';

// ════════════════════════════════════════════════════════════
// paper_send（U10c）：把本房间发起的任务的成品发回本群。
// 类型白名单（位图走 image、MP4 走 video、单个 HTML 按开关与大小走 file），原扩展名须与按文件头判定的
// 类型一致；具名白纸被几个房间共用时，别的房间发起的任务的成品按「找不到」回；文件名由宿主按任务名重写。
// 交给网关即标为已交付，结果写「已交给发送队列」。
// ════════════════════════════════════════════════════════════

afterEach(stopPaperHubs);

const PAPER_ID = `n:${PAPER}`;
const OUT = `paper:/n-${PAPER}/tasks`;
const now = Date.now();

type Artifact = TaskRecord['artifacts'][number];
const art = (id: string, rel: string, type: Artifact['type'], sizeBytes = 1024): Artifact => ({
  id,
  rel,
  type,
  sizeBytes,
});

function done(id: string, artifacts: Artifact[], over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    paperId: PAPER_ID,
    room: ROOM,
    platform: 'onebot',
    initiator: { platform: 'onebot', userId: '30001' },
    name: '像素猫',
    text: '原文',
    state: 'done',
    createdAt: now - 600_000,
    startedAt: now - 500_000,
    endedAt: now - 60_000,
    artifacts,
    notice: { id: `n-${id.slice(2)}`, at: now - 60_000 },
    delivered: false,
    ...over,
  };
}

const MINE = done('t-00000001', [
  art('a-00000001', 'cat.png', 'png'),
  art('a-00000002', 'photo.jpeg', 'jpeg'),
  art('a-00000003', 'clip.mp4', 'mp4'),
  art('a-00000004', 'index.html', 'html', 4 * 1024 * 1024),
  art('a-00000005', 'big.html', 'html', 6 * 1024 * 1024),
  art('a-00000006', 'site.zip', 'other'),
  art('a-00000007', 'setup.exe', 'other'),
  art('a-00000008', 'logo.svg', 'other'),
  art('a-00000009', 'data.bin', 'other'),
  art('a-0000000a', 'fake.gif', 'png'),
  art('a-0000000b', 'run.sh', 'other'),
  art('a-0000000c', 'report.docm', 'other'),
  art('a-0000000d', 'app.msi', 'other'),
  art('a-0000000e', 'open.lnk', 'other'),
  art('a-0000000f', 'anim.webp', 'webp'),
  art('a-00000010', 'preview.mp4', 'mp4', 15 * 1024 * 1024),
  art('a-00000011', 'anim.gif', 'gif', 12 * 1024 * 1024),
  art('a-00000012', 'small.mp4', 'mp4', 10 * 1024 * 1024),
]);
const OTHER_ROOM = done('t-00000002', [art('a-00000021', 'x.png', 'png')], { room: ROOM2 });
const OTHER_PAPER = done('t-00000003', [art('a-00000031', 'x.png', 'png')], { paperId: 'n:zz-other' });
const CLEARED = done('t-00000004', [art('a-00000041', 'x.png', 'png')], { artifactsCleared: true });

function seed(tasks: TaskRecord[] = [MINE, OTHER_ROOM, OTHER_PAPER, CLEARED]): PaperFiles {
  const ledger = emptyLedger();
  ledger.papers[PAPER_ID] = { lastClearedAt: now };
  for (const task of tasks) ledger.tasks[task.id] = task;
  return new Map([[LEDGER_URI, JSON.stringify(ledger)]]);
}

async function hub(opts: { config?: Record<string, unknown>; tasks?: TaskRecord[] } = {}) {
  return startPaperHub({ files: seed(opts.tasks), config: opts.config ?? PILOT_CONFIG });
}

describe('paper_send：发出', () => {
  it.each([
    'publish:work-1',
    `paper:${PAPER_ID}:t-00000007`,
  ])('%s 通知不能发送本房间另一件任务的文件，真人后续仍能主动发送', async source => {
    const h = await hub();
    const refused = await h.call(
      'paper_send',
      { artifact_id: 'a-00000001' },
      {
        sessionId: ROOM,
        platform: 'onebot',
        inbound: { source },
      },
    );
    expect(refused.ok).toBe(false);
    expect(h.outbound).toHaveLength(0);
    expect(h.ledger().tasks[MINE.id].delivered).toBe(false);
    expect(await h.call('paper_send', { artifact_id: 'a-00000001' }, human())).toMatchObject({ ok: true });
    expect(h.outbound).toHaveLength(1);
  });

  it('登记在 paper 分组、不声明 risk', async () => {
    const h = await hub();
    const tool = h.tools.get('paper_send');
    expect(tool?.groups).toEqual(['paper']);
    expect(tool?.risk).toBeUndefined();
  });

  it('PNG 走 image：出站附件指向白纸根，文件名按任务名重写，交给网关后标为已交付', async () => {
    const h = await hub();
    const res = await h.call('paper_send', { artifact_id: 'a-00000001' });
    expect(res).toMatchObject({ ok: true });
    expect(String(res.message)).toContain('已交给发送队列');
    expect(h.outbound).toEqual([
      {
        sessionId: ROOM,
        platform: 'onebot',
        content: '',
        source: 'agent',
        attachments: [
          { kind: 'image', data: `${OUT}/t-00000001/out/a-00000001.png`, name: '像素猫.png', mimeType: 'image/png' },
        ],
      },
    ]);
    expect(h.ledger().tasks['t-00000001'].delivered).toBe(true);
  });

  it('JPEG、WebP 走 image，MP4 走 video', async () => {
    const h = await hub();
    for (const id of ['a-00000002', 'a-0000000f', 'a-00000003']) {
      expect(await h.call('paper_send', { artifact_id: id })).toMatchObject({ ok: true });
    }
    expect(h.outbound.map(m => m.attachments?.[0])).toEqual([
      { kind: 'image', data: `${OUT}/t-00000001/out/a-00000002.jpg`, name: '像素猫.jpg', mimeType: 'image/jpeg' },
      { kind: 'image', data: `${OUT}/t-00000001/out/a-0000000f.webp`, name: '像素猫.webp', mimeType: 'image/webp' },
      { kind: 'video', data: `${OUT}/t-00000001/out/a-00000003.mp4`, name: '像素猫.mp4', mimeType: 'video/mp4' },
    ]);
  });

  it('网关发送失败时不标为已交付', async () => {
    const h = await startPaperHub({ files: seed(), gatewayFails: true });
    const res = await h.call('paper_send', { artifact_id: 'a-00000001' });
    expect(res.ok).toBe(false);
    expect(h.ledger().tasks['t-00000001'].delivered).toBe(false);
  });
});

describe('paper_send：拒绝', () => {
  it.each([
    ['a-00000006', '压缩包'],
    ['a-00000007', '可执行文件'],
    ['a-00000008', 'SVG'],
    ['a-0000000b', '脚本'],
    ['a-0000000c', '宏'],
    ['a-0000000d', '安装包'],
    ['a-0000000e', '快捷方式'],
    ['a-00000009', '只发'],
  ])('安全：%s 被拒并说明原因（%s）', async (id, reason) => {
    const h = await hub();
    const res = await h.call('paper_send', { artifact_id: id });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain(reason);
    expect(h.outbound).toEqual([]);
  });

  it('安全：原扩展名与按文件头判定的类型不一致时被拒（PNG 内容配 .gif）', async () => {
    const h = await hub();
    const res = await h.call('paper_send', { artifact_id: 'a-0000000a' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('.gif');
    expect(h.outbound).toEqual([]);
  });

  it('安全：别的白纸的成品按找不到回', async () => {
    const h = await hub();
    const res = await h.call('paper_send', { artifact_id: 'a-00000031' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('没有成品 a-00000031');
    expect(h.outbound).toEqual([]);
  });

  it('安全：同一具名白纸上别的房间发起的任务的成品按找不到回', async () => {
    const h = await hub();
    const res = await h.call('paper_send', { artifact_id: 'a-00000021' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('没有成品 a-00000021');
    expect(h.outbound).toEqual([]);
    // 那个房间自己能发
    expect(await h.call('paper_send', { artifact_id: 'a-00000021' }, human('30002', ROOM2))).toMatchObject({
      ok: true,
    });
  });

  it('已随白纸清空的成品被拒', async () => {
    const h = await hub();
    const res = await h.call('paper_send', { artifact_id: 'a-00000041' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('清空');
  });

  it('不在消息驱动的回合里、子会话、房间没开白纸时被拒', async () => {
    const h = await startPaperHub({
      files: seed(),
      children: { 'onebot:10000:group:20001:child': ROOM },
      rooms: { [ROOM]: PILOT_ROOM, 'onebot:10000:private:30009': {} },
    });
    const noInbound = { sessionId: ROOM, platform: 'onebot', userId: '30001' };
    expect((await h.call('paper_send', { artifact_id: 'a-00000001' }, noInbound)).ok).toBe(false);
    const child = human('30001', 'onebot:10000:group:20001:child');
    expect((await h.call('paper_send', { artifact_id: 'a-00000001' }, child)).ok).toBe(false);
    const closed = human('30001', 'onebot:10000:private:30009');
    expect((await h.call('paper_send', { artifact_id: 'a-00000001' }, closed)).ok).toBe(false);
    expect(h.outbound).toEqual([]);
  });

  it('宿主通知回合（source 非空、无主体）也能发', async () => {
    const h = await hub();
    const ctx = {
      sessionId: ROOM,
      platform: 'onebot',
      actor: { platform: 'onebot', userId: '' },
      inbound: { source: `paper:${PAPER_ID}:t-00000001` },
    };
    expect(await h.call('paper_send', { artifact_id: 'a-00000001' }, ctx)).toMatchObject({ ok: true });
  });
});

describe('paper_send：文件名', () => {
  it('安全：去掉 RLO、零宽字符、路径分隔符与 :*?"<>|，首尾去点和空格，截到 40 字', async () => {
    const h = await hub({
      tasks: [
        done('t-00000001', [art('a-00000001', 'x.png', 'png')], {
          name: ' ..报‮gnp.exe/..\\告​:*?"<>|.. ',
        }),
        done('t-00000002', [art('a-00000002', 'x.png', 'png')], { name: '长'.repeat(50) }),
        done('t-00000003', [art('a-00000003', 'x.png', 'png')], { name: '‮/\\:*?"<>|. ' }),
      ],
    });
    for (const id of ['a-00000001', 'a-00000002', 'a-00000003']) {
      expect(await h.call('paper_send', { artifact_id: id })).toMatchObject({ ok: true });
    }
    const names = h.outbound.map(m => m.attachments?.[0].name ?? '');
    expect(names).toEqual(['报gnp.exe..告.png', `${'长'.repeat(40)}.png`, 'aalis-paper.png']);
    for (const name of names) expect(name).not.toMatch(/[‮​/\\:*?"<>|]/);
  });
});

describe('paper_send：媒体大小', () => {
  it('超过 10 MiB 的视频与图片被拒（聊天平台只内联发得出这么大的），拒绝时不标为已交付', async () => {
    const h = await hub();
    for (const id of ['a-00000010', 'a-00000011']) {
      const res = await h.call('paper_send', { artifact_id: id });
      expect(res.ok, id).toBe(false);
      expect(String(res.error), id).toContain('10.0 MB');
    }
    expect(h.outbound).toEqual([]);
    expect(h.ledger().tasks['t-00000001'].delivered).toBe(false);
    expect(await h.call('paper_send', { artifact_id: 'a-00000012' }), '正好 10 MiB 照发').toMatchObject({ ok: true });
  });

  it('上限取插件配置 sendMediaMaxMB', async () => {
    const h = await hub({ config: { ...PILOT_CONFIG, sendMediaMaxMB: 20 } });
    expect(await h.call('paper_send', { artifact_id: 'a-00000010' })).toMatchObject({ ok: true });
  });
});

describe('paper_send：单个 HTML', () => {
  it('开启且不超过大小上限时走 file，data 为白纸根 URI', async () => {
    const h = await hub();
    expect(await h.call('paper_send', { artifact_id: 'a-00000004' })).toMatchObject({ ok: true });
    expect(h.outbound[0].attachments).toEqual([
      { kind: 'file', data: `${OUT}/t-00000001/out/a-00000004.html`, name: '像素猫.html', mimeType: 'text/html' },
    ]);
  });

  it('超过 sendHtmlMaxMB 被拒', async () => {
    const h = await hub();
    const res = await h.call('paper_send', { artifact_id: 'a-00000005' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('5.0 MB');
    expect(h.outbound).toEqual([]);
  });

  it('sendHtml 关闭时被拒', async () => {
    const h = await hub({ config: { ...PILOT_CONFIG, sendHtml: false } });
    const res = await h.call('paper_send', { artifact_id: 'a-00000004' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('网页');
    expect(h.outbound).toEqual([]);
  });
});
