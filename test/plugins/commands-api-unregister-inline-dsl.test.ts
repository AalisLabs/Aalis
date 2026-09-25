/**
 * api-commands — 带 inline 位置参数 DSL 的指令，注销时必须用注册表的那份键
 *
 * 注册侧 CommandRegistry.command() 先过 parseCommandName，按点路径（'memo.clear'）建键；
 * 而门面的清理回调若把**原始名**（'memo.clear <key:string>'）传回 unregister，
 * 键不匹配 → 整条注销静默 no-op，留下幽灵指令。
 *
 * 用例走的是「commands 提供者下线」这条路：插件拆卸和提供者下线都经门面的跟随回调注销，
 * 这里选提供者下线，是为了不引入 required 依赖降级、拆激活带来的干扰。
 */
import { App, definePlugin, optional, provide } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { commands } from '../../packages/api-commands/src/index.js';
import { CommandRegistry } from '../../packages/plugin-commands/src/commands.js';

const mkLogger = () => {
  const l = { warn() {}, debug() {}, info() {}, error() {}, child: () => mkLogger() };
  return l;
};

/** 注册一条指令，随后让 commands 提供者下线，返回旧注册表里剩下的节点名。 */
async function namesAfterProviderDown(declaration: string): Promise<string[]> {
  const app = new App({ name: 'T', logLevel: 'error' });
  const host = app.bind({ provide });
  const registry = new CommandRegistry(mkLogger() as never);
  const handle = host.provide(commands, registry);

  // commands 声明为**可选**依赖：提供者下线时探针保持激活，清理只经门面的跟随回调。
  // 声明为 required 的话 core 会连带把插件降级、拆掉它的激活，引入与本 bug 无关的干扰。
  const probe = definePlugin({
    name: 'dsl-probe',
    uses: { commands: optional(commands) },
    apply(caps) {
      caps.commands.command(declaration, 'x').action(async () => 'ok');
    },
  });
  await app.plugin(probe);
  await app.plugins.idle();
  const state = app.plugins.getPlugin(probe.name)?.state;
  if (state !== 'active') throw new Error(`探针 "${probe.name}" 未激活（state=${state}）`);

  expect(
    registry.getAll().map(c => c.name),
    '注册表按点路径建键',
  ).toContain('memo.clear');

  handle();
  // 服务下线经事件广播到达跟随者：等宏任务把微任务队列排空，再等状态机静置
  await new Promise(r => setTimeout(r, 0));
  await app.plugins.idle();

  const names = registry.getAll().map(c => c.name);
  await app.stop();
  return names;
}

describe('commands 门面 — inline DSL 指令的注销', () => {
  it('带位置参数声明的指令，提供者下线后节点被摘掉', async () => {
    expect(
      await namesAfterProviderDown('memo.clear <key:string>'),
      '带 inline DSL 的指令注销落空，旧注册表留着幽灵指令',
    ).not.toContain('memo.clear');
  });

  it('不带位置参数的指令照旧能注销（反向锚）', async () => {
    expect(await namesAfterProviderDown('memo.clear')).not.toContain('memo.clear');
  });
});
