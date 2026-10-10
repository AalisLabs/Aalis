import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthorityService } from '../../packages/api-authority/src/index.js';
import { commands } from '../../packages/api-commands/src/index.js';
import type {} from '../../packages/api-gateway/src/index.js';
import { type App, events, type Logger } from '../../packages/core/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import { CommandRegistry } from '../../packages/plugin-commands/src/commands.js';
import { brief } from '../../packages/plugin-commands/src/help.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// /help：所有平台同一份纯文本（QQ 与终端原样显示，WebUI 按 Markdown 渲染成列表），不用加粗、反引号、代码围栏与空格对列；
// 概览与详情只列调用者能用的指令，判据与执行时的权限判据同一份。用不了的指令在帮助里当作不存在：
// `/help <它>` 与指令不存在时回同一句，`<它> -h` 与裸敲子指令都用不了的分组回的也是这一句；直接执行它，拒绝提示照旧。
// ════════════════════════════════════════════════════════════

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent } as unknown as Logger;
const allowAll = { authorize: () => null } as unknown as AuthorityService;
const caller = { platform: 'test', userId: 'u' };

/** 没有加粗、反引号与代码围栏，不用空格对列（行首缩进除外） */
function expectPlain(text: string): void {
  expect(text).not.toMatch(/\*\*|`/);
  for (const line of text.split('\n')) expect(line.trimStart(), line).not.toMatch(/ {2}/);
}

describe('help: 摘要取描述的第一句', () => {
  it('到第一个句号、分号、问号、叹号或换行为止', () => {
    expect(brief('舞萌 DX 查分。绑定好友码后可以不写查询目标')).toBe('舞萌 DX 查分');
    expect(brief('清空当前会话记忆；用 --type 选择类型')).toBe('清空当前会话记忆');
    expect(brief('要现在重启吗？会断开连接')).toBe('要现在重启吗');
    expect(brief('第一行\n第二行')).toBe('第一行');
  });

  it('第一句里的逗号、顿号、冒号与括号不切', () => {
    expect(brief('关系图体检：先整理再压缩，报告全过程。整理含别名')).toBe('关系图体检：先整理再压缩，报告全过程');
    expect(brief('设定当前对话的模型（会话级覆盖）')).toBe('设定当前对话的模型（会话级覆盖）');
  });

  it('第一句过长时截断，省略号紧跟文字', () => {
    expect(brief('查看当前对话生效的模型 / 人设 / 深度思考 / 名称及来源')).toBe(
      '查看当前对话生效的模型 / 人设 / 深度思考…',
    );
    expect(brief('')).toBe('');
  });
});

describe('help: 各平台通用的纯文本', () => {
  function registry(): CommandRegistry {
    const r = new CommandRegistry(silent, () => allowAll);
    r.command('clear', '清空当前会话记忆；用 --type 选择类型', { examples: ['/clear', '/clear -t context,vector'] })
      .alias('cls')
      .option('type', '-t <type:string[]>', {
        description: '清理类型，可重复或用逗号分隔',
        choices: [{ value: 'all', description: '全部类型' }, { value: 'context', description: '消息历史' }, 'vector'],
      })
      .option('force', '--force', { description: '不问直接清' })
      .action(() => 'ok');
    r.command('clear.all', '【危险】清空全部会话').action(() => 'ok');
    r.command('song <keyword:string> [page:number]', '搜索曲目。按曲名、艺术家或别名找')
      .argument('keyword', '曲名、艺术家或别名')
      .action(() => 'ok');
    r.command('status', '显示系统状态').action(() => 'ok');
    r.command('relation', '关系图的查看与维护');
    r.command('relation.show <id:string>', '查看节点').action(() => 'ok');
    r.command('relation.cleanup.person <id:string>', '删除人物').action(() => 'ok');
    r.command('relation.cleanup.event <id:string>', '删除事件').action(() => 'ok');
    r.command('tags.add', '加标签').action(() => 'ok');
    return r;
  }

  it('概览：一行一条「- /指令 — 摘要 · 子指令数」，自动分组只报子指令数，末尾提示详情与 -h', () => {
    expect(registry().overview(caller)).toBe(
      [
        '可用指令（5 条）：',
        '- /clear — 清空当前会话记忆 · 1 个子指令',
        '- /relation — 关系图的查看与维护 · 2 个子指令',
        '- /song — 搜索曲目',
        '- /status — 显示系统状态',
        '- /tags — 1 个子指令',
        '',
        '详情：/help 指令名，或在指令后加 -h',
      ].join('\n'),
    );
  });

  it('详情按用法、示例、参数、选项、子指令、别名排列；选项一行一个，取值与说明逐项列在下面', () => {
    expect(registry().detail(['clear'], caller)).toBe(
      [
        '/clear — 清空当前会话记忆；用 --type 选择类型',
        '',
        '用法：/clear [选项]',
        '',
        '示例：',
        '- /clear',
        '- /clear -t context,vector',
        '',
        '选项：',
        '- --type, -t <type>：清理类型，可重复或用逗号分隔',
        '  - all：全部类型',
        '  - context：消息历史',
        '  - vector',
        '- --force：不问直接清',
        '',
        '子指令：',
        '- /clear all — 【危险】清空全部会话',
        '',
        '别名：/cls',
      ].join('\n'),
    );
  });

  it('位置参数写成 <名字> 与 [名字]，带说明的列在「参数」下', () => {
    expect(registry().detail(['song'], caller)).toBe(
      [
        '/song — 搜索曲目。按曲名、艺术家或别名找',
        '',
        '用法：/song <keyword> [page]',
        '',
        '参数：',
        '- <keyword>：曲名、艺术家或别名',
      ].join('\n'),
    );
  });

  it('分组的详情：用法写 <子指令>；子指令里的自动分组不显示占位文字，只报子指令数', () => {
    expect(registry().detail(['relation'], caller)).toBe(
      [
        '/relation — 关系图的查看与维护',
        '',
        '用法：/relation <子指令>',
        '',
        '子指令：',
        '- /relation cleanup — 2 个子指令',
        '- /relation show — 查看节点',
      ].join('\n'),
    );
    expect(registry().detail(['relation', 'cleanup'], caller)).toBe(
      [
        '/relation cleanup',
        '',
        '用法：/relation cleanup <子指令>',
        '',
        '子指令：',
        '- /relation cleanup event — 删除事件',
        '- /relation cleanup person — 删除人物',
      ].join('\n'),
    );
  });
});

describe('help: 没有权限插件时按执行时的 fail-closed 列', () => {
  it('只列默认等级能用、不用确认的指令', () => {
    const r = new CommandRegistry(silent, () => undefined);
    r.command('open', '公开').action(() => 'ok');
    r.command('ask', '要确认', { confirm: 'session' }).action(() => 'ok');
    r.command('high', '要等级', { risk: 'sensitive' }).action(() => 'ok');
    expect(r.overview(caller)).toBe(
      ['可用指令（1 条）：', '- /open — 公开', '', '详情：/help 指令名，或在指令后加 -h'].join('\n'),
    );
    expect(r.detail(['ask'], caller)).toBe('没有指令 ask。敲 /help 看可用指令。');
  });
});

describe('help: 登记', () => {
  const r = () => new CommandRegistry(silent, () => allowAll);

  it('-h 与 --help 是保留选项：声明它们的选项登记时抛错', () => {
    expect(() => r().command('a').option('help', '')).toThrow(/保留/);
    expect(() => r().command('a').option('host', '-h <host:string>')).toThrow(/保留/);
    expect(() => r().command('a').option('more', '--help')).toThrow(/保留/);
    expect(() => r().command('a').option('h', '<n:number>')).toThrow(/保留/);
  });

  it('argument 只给 DSL 里声明过的位置参数加说明', () => {
    expect(() => r().command('a <x:string>').argument('y', '说明')).toThrow(/没有位置参数 y/);
    const reg = r();
    reg.command('a <x:string>').argument('x', '说明');
    expect(reg.get('a')?.positionalArgs).toEqual([{ name: 'x', type: 'string', required: true, description: '说明' }]);
  });

  it('取值可以只写值，也可以带说明；string 选项按值校验', async () => {
    const reg = r();
    reg
      .command('unit')
      .option('to', '-t <to:string>', { choices: ['c', { value: 'f', description: '华氏' }] })
      .action(argv => String(argv.options.to));
    const run = (args: string[]) => reg.execute('unit', { sessionId: 's', platform: 'test', args, raw: '' });
    expect(await run(['-t', 'f'])).toBe('f');
    expect(await run(['-t', 'k'])).toBe('选项 --to 只能是: c, f');
  });

  it('负数没有同名选项时是位置参数；有同名选项的照旧当选项', async () => {
    const reg = r();
    reg.command('level <target:string> <level:number>').action((_argv, target, level) => `${target} ${level}`);
    reg
      .command('pick [n:number]')
      .option('one', '-1')
      .action((argv, n) => `${String(n)} ${String(argv.options.one)}`);
    const run = (name: string, args: string[]) =>
      reg.execute(name, { sessionId: 's', platform: 'test', args, raw: '' });
    expect(await run('level', ['x:1', '-1'])).toBe('x:1 -1');
    expect(await run('level', ['x:1', '-2.5'])).toBe('x:1 -2.5');
    expect(await run('pick', ['-1'])).toBe('undefined true');
    expect(await run('pick', ['-2'])).toBe('-2 undefined');
  });

  it('选项名本身以 no- 开头：--no-xxx 按名字取，不当作 xxx 的反写', async () => {
    const reg = r();
    reg
      .command('sync')
      .option('no-llm', '--no-llm', { description: '不用模型' })
      .option('cache', '--cache')
      .action(argv => JSON.stringify(argv.options));
    const run = (args: string[]) => reg.execute('sync', { sessionId: 's', platform: 'test', args, raw: '' });
    expect(await run(['--no-llm'])).toBe('{"no-llm":true}');
    expect(await run(['--no-cache'])).toBe('{"cache":false}');
  });
});

// ════════════════════════════════════════════════════════════
// 真实的网关、指令与权限插件：同一句 /help 在 QQ 群与 WebUI 里由不同等级的人发出
// ════════════════════════════════════════════════════════════

const MEMBER = { platform: 'onebot', userId: '30001', sessionId: 'onebot:10000:group:20001', sessionType: 'group' };
const OWNER = { platform: 'webui', userId: 'console', sessionId: 'webui:s1', sessionType: 'private' };
type Who = typeof MEMBER;

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup(appConfig: object = {}) {
  const { app } = hostedApp(appConfig);
  apps.push(app);
  await registerHubs(app);
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(gatewayPlugin);
  await app.plugin(commandsPlugin);
  await app.plugin(authorityPlugin);
  await app.plugins.idle();
  for (const p of [gatewayPlugin, commandsPlugin, authorityPlugin]) {
    const state = app.plugins.getPlugin(p.name)?.state;
    if (state !== 'active') throw new Error(`${p.name} 未激活（state=${state}）`);
  }
  const host = app.bind({ events, commands });
  const ran: string[] = [];
  host.commands.use
    .command('probe <keyword:text>', '探针。按关键词查找', { examples: ['/probe 苹果'] })
    .argument('keyword', '要找的词')
    .option('mode', '-m <mode:string>', {
      description: '查找方式',
      choices: [{ value: 'exact', description: '完全一致' }, 'fuzzy'],
    })
    .alias('pb')
    .action(() => {
      ran.push('probe');
      return 'found';
    });
  host.commands.use.command('admin.reset', '重置', { visibility: 'restricted' }).action(() => 'reset');
  host.commands.use.command('mixed.open', '公开的').action(() => 'open');
  host.commands.use.command('mixed.secret', '受限的', { visibility: 'restricted' }).action(() => 'secret');
  const replies: string[] = [];
  host.events.use.on('outbound:message', msg => {
    replies.push(msg.content);
  });
  /** 以 who 的身份发一句，取这一句的回复 */
  const ask = async (who: Who, content: string): Promise<string> => {
    const before = replies.length;
    await host.events.use.emit('inbound:message', { ...who, content } as IncomingMessage);
    await vi.waitFor(() => expect(replies.length).toBe(before + 1));
    return replies[before];
  };
  return { app, ask, ran };
}

const HINT = '详情：/help 指令名，或在指令后加 -h';

describe('help: 按调用者的等级过滤', () => {
  it('0 级群成员的概览只列能用的，用不了的一条都不出现、也不提数目；owner 的概览列全部', async () => {
    const { ask } = await setup();
    expect(await ask(MEMBER, '/help')).toBe(
      [
        '可用指令（4 条）：',
        '- /clear — 清空当前会话记忆',
        '- /mixed — 1 个子指令',
        '- /probe — 探针',
        '- /status — 显示系统状态',
        '',
        HINT,
      ].join('\n'),
    );
    const owner = await ask(OWNER, '/help');
    expect(owner.split('\n')[0]).toBe('可用指令（9 条）：');
    for (const line of [
      '- /admin — 1 个子指令',
      '- /authority — 查看自己或指定用户的权限等级',
      '- /clear — 清空当前会话记忆 · 1 个子指令',
      '- /level — 设置用户的权限等级',
      '- /mixed — 2 个子指令',
      '- /restart — 重启应用',
      '- /shutdown — 关闭应用',
    ]) {
      expect(owner).toContain(line);
    }
  });

  it('/help <用不了的指令> 与指令不存在时一样；owner 照常看到详情', async () => {
    const { ask } = await setup();
    expect(await ask(MEMBER, '/help nosuch')).toBe('没有指令 nosuch。敲 /help 看可用指令。');
    expect(await ask(MEMBER, '/help shutdown')).toBe('没有指令 shutdown。敲 /help 看可用指令。');
    expect(await ask(MEMBER, '/help clear all')).toBe('没有指令 clear all。敲 /help 看可用指令。');
    expect(await ask(MEMBER, '/help admin')).toBe('没有指令 admin。敲 /help 看可用指令。');
    expect(await ask(OWNER, '/help shutdown')).toBe('/shutdown — 关闭应用\n\n用法：/shutdown');
  });

  it('直接执行用不了的指令：拒绝提示照旧点名指令', async () => {
    const { ask } = await setup();
    expect(await ask(MEMBER, '/shutdown')).toBe('权限不足: "command:shutdown" 需等级 2（当前 0）');
  });

  it('-h 与 --help 回的就是 /help <指令>：忽略同时写的参数，不执行；用不了的同样当作不存在', async () => {
    const { ask, ran } = await setup();
    const detail = await ask(MEMBER, '/help probe');
    expect(detail.split('\n')[0]).toBe('/probe — 探针。按关键词查找');
    expect(await ask(MEMBER, '/probe -h')).toBe(detail);
    expect(await ask(MEMBER, '/probe 苹果 -m exact --help')).toBe(detail);
    expect(await ask(MEMBER, '/pb -h')).toBe(detail);
    expect(ran).toEqual([]);
    expect(await ask(MEMBER, '/clear all -h')).toBe(await ask(MEMBER, '/help clear all'));
    const ownerDetail = await ask(OWNER, '/help clear all');
    expect(ownerDetail).toMatch(/^\/clear all — 【危险】/);
    expect(await ask(OWNER, '/clear all -h')).toBe(ownerDetail);
    expect(await ask(OWNER, '/help clear.all')).toBe(ownerDetail);
    expect(await ask(MEMBER, '/probe -- -h')).toBe('found');
  });

  it('裸敲分组：只列调用者能用的子指令；子指令都用不了的分组当作不存在', async () => {
    const { ask } = await setup();
    expect(await ask(MEMBER, '/mixed')).toBe('/mixed\n\n用法：/mixed <子指令>\n\n子指令：\n- /mixed open — 公开的');
    expect(await ask(OWNER, '/mixed')).toContain('- /mixed secret — 受限的');
    expect(await ask(MEMBER, '/admin')).toBe('没有指令 admin。敲 /help 看可用指令。');
  });

  it('未知选项：能用的指令附上用法；用不了的只回错误', async () => {
    const { ask } = await setup();
    expect(await ask(MEMBER, '/probe x --bogus')).toBe(`未知选项: --bogus\n\n${await ask(MEMBER, '/help probe')}`);
    expect(await ask(MEMBER, '/clear all --bogus')).toBe('未知选项: --bogus');
    expect(await ask(OWNER, '/clear all --bogus')).toBe(`未知选项: --bogus\n\n${await ask(OWNER, '/help clear all')}`);
  });

  it('判据与执行同一份：authorityOverrides 放开的列出，deniedCapabilities 禁掉的不列', async () => {
    const { ask } = await setup({
      authorityOverrides: { 'command:restart': 0 },
      deniedCapabilities: ['command:status'],
    });
    const overview = await ask(MEMBER, '/help');
    expect(overview).toContain('- /restart — 重启应用');
    expect(overview).not.toContain('/status');
    expect(await ask(MEMBER, '/status')).toBe('已被系统禁用: command:status');
  });

  it('停用权限插件之后帮助与执行一致：都按 fail-closed，owner 的帮助不列受限指令，直接执行也被拒', async () => {
    const { app, ask } = await setup();
    expect(await ask(OWNER, '/admin reset')).toBe('reset');
    await app.plugins.disable(authorityPlugin.name);
    await app.plugins.idle();
    expect(await ask(OWNER, '/help')).not.toContain('/admin');
    expect(await ask(OWNER, '/admin reset')).toContain('未安装权限插件');
    expect(await ask(OWNER, '/probe 苹果')).toBe('found');
  });

  it('QQ 群与 WebUI 里的回复都是纯文本：没有 Markdown 记号与空格对列', async () => {
    const { ask } = await setup();
    for (const who of [MEMBER, OWNER]) {
      for (const line of ['/help', '/help clear', '/help probe', '/mixed', '/probe -h'])
        expectPlain(await ask(who, line));
    }
  });
});
