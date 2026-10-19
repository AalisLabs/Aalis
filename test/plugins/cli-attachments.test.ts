import { App, definePlugin, events, LogHub, provide } from '@aalis/core';
import type { LogEntry } from '@aalis/schema-log';
import type { OutgoingMessage } from '@aalis/schema-message';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platform } from '../../packages/api-platform/src/index.js';
import cliPlugin from '../../packages/plugin-cli/src/index.js';
import { fakeTty } from '../helpers/tty.js';

// CLI 会话里的附件：终端显示不了图片本身，写一行说明（类型、名称、大小、本机路径；取不到路径时写存储地址），
// 写出即算送达（填 delivery 并发 outbound:delivered，照常归档）。附件消息不往终端写空行。
// 用非 TTY 模式：出站消息落成 `[cli] …` 日志，便于断言。流式去重那一支只在 TUI 里走到，那两条用例起真 TUI、看最后一帧。

const FRAME_SPLIT = '\x1b[?25l\x1b[H';
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');

afterEach(() => {
  vi.restoreAllMocks();
});

const bindHost = (app: App) => app.bind({ events });

interface Cli {
  app: App;
  host: ReturnType<typeof bindHost>;
  /** 日志条目：非 TTY 模式下出站消息落成 `[cli] …` */
  entries: LogEntry[];
  delivered: OutgoingMessage[];
}

/** 非 TTY 模式起 CLI。before 在装 CLI 之前跑（在那里装的插件登记的出站监听排在 CLI 的前面），收尾还原 isTTY 并停掉 app */
async function headlessCli(run: (cli: Cli) => Promise<void>, before?: (app: App) => Promise<unknown>): Promise<void> {
  const tty = { out: process.stdout.isTTY, in: process.stdin.isTTY };
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const entries: LogEntry[] = [];
  const offLog = LogHub.default.onEntry(e => entries.push(e));
  const app = new App({ name: 'T', logLevel: 'info' });
  const host = bindHost(app);
  const delivered: OutgoingMessage[] = [];
  host.events.use.on('outbound:delivered', msg => void delivered.push(msg));
  try {
    await before?.(app);
    await app.plugin(cliPlugin, {});
    await app.start();
    expect(app.plugins.getPlugin(cliPlugin.name)?.state).toBe('active');
    await run({ app, host, entries, delivered });
  } finally {
    offLog();
    await app.stop().catch(() => {});
    Object.defineProperty(process.stdout, 'isTTY', { value: tty.out, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: tty.in, configurable: true });
  }
}

describe('plugin-cli 附件', () => {
  it('附件写成一行说明并算送达；没有存储服务时写存储地址；附件消息不写空行', () =>
    headlessCli(async ({ host, entries, delivered }) => {
      const message: OutgoingMessage = {
        sessionId: 'cli-default',
        platform: 'cli',
        content: '',
        source: 'agent',
        attachments: [
          { kind: 'image', data: 'data:/images/cat.png', name: '猫.png' },
          { kind: 'file', data: 'https://example.invalid/page.html', name: '主页.html' },
          { kind: 'audio', data: 'https://example.invalid/hello.mp3', name: '问好.mp3' },
          { kind: 'video', data: 'https://example.invalid/clip.mp4', name: '片段.mp4' },
        ],
      };
      await host.events.use.emit('outbound:message', message);
      expect(message.delivery, 'CLI 认领了这条消息').toBeDefined();
      expect(await message.delivery).toEqual({ ok: true });

      const lines = entries.map(e => e.message).filter(m => m.startsWith('[cli]'));
      expect(lines).toContain('[cli] [图片] 猫.png · data:/images/cat.png');
      expect(lines).toContain('[cli] [文件] 主页.html https://example.invalid/page.html');
      expect(lines).toContain('[cli] [音频] 问好.mp3 https://example.invalid/hello.mp3');
      expect(lines).toContain('[cli] [视频] 片段.mp4 https://example.invalid/clip.mp4');
      expect(lines, '附件消息的空正文不写成空行').not.toContain('[cli] ');
      await vi.waitFor(() => expect(delivered).toHaveLength(1));
      expect(delivered[0].attachments?.map(a => a.data)).toEqual([
        'data:/images/cat.png',
        'https://example.invalid/page.html',
        'https://example.invalid/hello.mp3',
        'https://example.invalid/clip.mp4',
      ]);

      // 对照：别的会话的附件不认领
      const other: OutgoingMessage = {
        sessionId: 'onebot:group:x',
        content: '',
        source: 'agent',
        attachments: [{ kind: 'image', data: 'data:/images/cat.png' }],
      };
      await host.events.use.emit('outbound:message', other);
      expect(other.delivery).toBeUndefined();
    }));

  it('纯文本（如作品通知）写出即算送达：同样认领回执、发出 outbound:delivered（不是她回复的文字据此记进历史）', () =>
    headlessCli(async ({ host, entries, delivered }) => {
      for (const source of ['system', 'agent'] as const) {
        const message: OutgoingMessage = {
          sessionId: 'cli-default',
          platform: 'cli',
          content: `[作品通知] 《猫》已上线 (${source})`,
          source,
        };
        await host.events.use.emit('outbound:message', message);
        expect(message.delivery, `CLI 认领了 ${source} 文本`).toBeDefined();
        expect(await message.delivery).toEqual({ ok: true });
        expect(entries.map(e => e.message)).toContain(`[cli] [作品通知] 《猫》已上线 (${source})`);
      }
      expect(delivered.map(msg => [msg.source, msg.content])).toEqual([
        ['system', '[作品通知] 《猫》已上线 (system)'],
        ['agent', '[作品通知] 《猫》已上线 (agent)'],
      ]);
    }));

  /** 发一条纯文本、一条带附件的：都写到终端，回执是别的入口给的 expected，不发 outbound:delivered */
  async function writtenNotClaimed(
    { host, entries, delivered }: Cli,
    message: (attachments?: OutgoingMessage['attachments']) => OutgoingMessage,
    expected: OutgoingMessage['delivery'],
  ) {
    for (const attachments of [undefined, [{ kind: 'image' as const, data: 'data:/images/chart.png' }]]) {
      const out = message(attachments);
      await host.events.use.emit('outbound:message', out);
      expect(out.delivery).toBe(expected);
      await vi.waitFor(() => expect(entries.map(e => e.message)).toContain(`[cli] ${out.content}`));
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(delivered).toEqual([]);
  }

  /** 另一个平台 zz-inbox 的适配器，认领出站的 platform 是它的消息（如 owner 从 WebUI 驱动这个会话时 WebUI 的收件箱） */
  const inbox = Promise.resolve({ ok: true as const });
  const inboxPlatform = definePlugin({
    name: 'zz-platform-inbox',
    provides: [platform],
    uses: { provide, events },
    apply: caps => {
      caps.provide.use(platform, {
        adapterName: 'ZZ',
        platform: 'zz-inbox',
        getConnections: () => [],
        sendMessage: async () => {},
      });
      caps.events.use.on('outbound:message', msg => {
        if (msg.platform === 'zz-inbox' && !msg.delivery) msg.delivery = inbox;
      });
    },
  });

  it.each([
    ['CLI 先装', false],
    ['那个平台先装', true],
  ])('出站的 platform 另有在场的适配器登记（%s）：照样写到终端，不认领、不发 outbound:delivered，回执归那个平台', (_order, inboxFirst) =>
    headlessCli(
      async cli => {
        if (!inboxFirst) {
          await cli.app.plugin(inboxPlatform);
          await cli.app.plugins.idle();
        }
        await writtenNotClaimed(
          cli,
          attachments => ({
            sessionId: 'cli-default',
            platform: 'zz-inbox',
            content: `/help 的回复 (${attachments ? '带附件' : '纯文本'})`,
            source: 'command',
            attachments,
          }),
          inbox,
        );
      },
      inboxFirst ? app => app.plugin(inboxPlatform) : undefined,
    ));

  it('出站的 platform 没有适配器（如工作流注入这个会话）：CLI 认领回执、发出 outbound:delivered，别的平台在场也一样', () =>
    headlessCli(
      async ({ app, host, entries, delivered }) => {
        expect(app.plugins.getPlugin(inboxPlatform.name)?.state).toBe('active');
        const message: OutgoingMessage = {
          sessionId: 'cli-default',
          platform: 'workflow',
          content: '工作流里的回复',
          source: 'agent',
        };
        await host.events.use.emit('outbound:message', message);
        expect(message.delivery, 'CLI 认领了这条消息').toBeDefined();
        expect(await message.delivery).toEqual({ ok: true });
        expect(entries.map(e => e.message)).toContain('[cli] 工作流里的回复');
        await vi.waitFor(() => expect(delivered.map(msg => msg.content)).toEqual(['工作流里的回复']));
      },
      app => app.plugin(inboxPlatform),
    ));

  it('回执已被别的入口认领：照样写到终端，不覆盖回执、不发 outbound:delivered', () =>
    headlessCli(async cli => {
      const claimed = Promise.resolve({ ok: true as const });
      await writtenNotClaimed(
        cli,
        attachments => ({
          sessionId: 'cli-default',
          platform: 'cli',
          content: `/help 的回复 (${attachments ? '带附件' : '纯文本'})`,
          source: 'command',
          attachments,
          delivery: claimed,
        }),
        claimed,
      );
    }));

  /** 起真 TUI，流式写出 streamed 后交出 message，回执照样认领为送达；交回最后一帧去掉 ANSI 控制码的画面 */
  async function afterStreamed(streamed: string, message: OutgoingMessage): Promise<string> {
    const tty = fakeTty(20, 100);
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      writes.push(String(chunk));
      return true;
    });
    const app = new App({ name: 'T', logLevel: 'error' });
    const host = app.bind({ events });
    const settle = () => new Promise<void>(r => setImmediate(() => setImmediate(r)));
    try {
      await app.plugin(cliPlugin, {});
      await app.start();
      await settle();
      const stream = (chunk: Record<string, unknown>) =>
        host.events.use.emit('outbound:stream', { sessionId: 'cli-default', platform: 'cli', ...chunk } as never);
      await stream({ contentDelta: streamed });
      await stream({ done: true });
      await host.events.use.emit('outbound:message', message);
      expect(message.delivery, '流式去重那一支同样认领回执').toBeDefined();
      expect(await message.delivery).toEqual({ ok: true });
      await settle();
      const all = writes.join('');
      return all.slice(all.lastIndexOf(FRAME_SPLIT)).replace(ANSI_RE, '');
    } finally {
      await app.stop().catch(() => {});
      tty.restore();
    }
  }

  it('TUI 里已流式写出的回复：去重跳过整条回复时，回执照样认领为送达', async () => {
    const frame = await afterStreamed('画好了', {
      sessionId: 'cli-default',
      platform: 'cli',
      content: '画好了',
      source: 'agent',
    });
    expect(frame.split('画好了').length - 1, '正文只有流式写出的那一份').toBe(1);
  });

  it('TUI 里已流式写出的回复带附件：正文不再写一遍，只补附件那一行', async () => {
    const frame = await afterStreamed('画好了一只猫', {
      sessionId: 'cli-default',
      platform: 'cli',
      content: '画好了一只猫',
      source: 'agent',
      attachments: [{ kind: 'image', data: 'data:/images/cat.png', name: '猫.png' }],
    });
    expect(frame.split('画好了一只猫').length - 1, '正文只有流式写出的那一份').toBe(1);
    expect(frame).toContain('[图片] 猫.png · data:/images/cat.png');
  });
});
