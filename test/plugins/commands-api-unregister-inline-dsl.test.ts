/**
 * api-commands — 带 inline 位置参数 DSL 的指令，注销时必须用注册表的那份键
 *
 * 注册侧 CommandRegistry.command() 先过 parseCommandName，按点路径（'memo.clear'）建键；
 * 而 makeBuilder 的清理回调此前把**原始名**（'memo.clear <key:string>'）传回 unregister，
 * 键不匹配 → 整条注销静默 no-op，留下幽灵指令。
 *
 * 用例走的是「commands 服务下线」这条路：插件 ctx 自身 dispose 时，core 的服务自清理协议
 * 会调 `unregisterByPlugin(contextId)` 把节点兜掉（实测），于是那条路径对本 bug 恒绿——
 * 只有 provider 下线（bounce 前半程）时，清理才**单独由** whenService 的回调承重。
 */
import {
  ConfigManager,
  Context,
  ContributionRegistry,
  DefaultLogger,
  EventBus,
  HookRegistry,
  ServiceContainer,
} from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { useCommandService } from '../../packages/api-commands/src/index.js';
import { CommandRegistry } from '../../packages/plugin-commands/src/commands.js';

function rootCtx(): Context {
  return new Context({
    id: 'cmd-dsl-test',
    events: new EventBus(),
    services: new ServiceContainer(),
    hooks: new HookRegistry(),
    contributions: new ContributionRegistry(),
    logger: new DefaultLogger('test'),
    config: new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} }),
  });
}

const mkLogger = () => {
  const l = { warn() {}, debug() {}, info() {}, error() {}, child: () => mkLogger() };
  return l;
};

/** 注册一条指令，随后让 commands 服务下线，返回旧注册表里剩下的节点名。 */
async function namesAfterProviderDown(declaration: string): Promise<string[]> {
  const root = rootCtx();
  const registry = new CommandRegistry(mkLogger() as never);
  const handle = root.provide('commands', registry);
  const a = root.fork('plugin-a');
  useCommandService(a)
    .command(declaration, 'x')
    .action(async () => 'ok');
  expect(
    registry.getAll().map(c => c.name),
    '注册表按点路径建键',
  ).toContain('memo.clear');
  handle();
  await new Promise(r => setTimeout(r, 0));
  return registry.getAll().map(c => c.name);
}

describe('useCommandService — inline DSL 指令的注销', () => {
  it('带位置参数声明的指令，provider 下线后节点被摘掉', async () => {
    expect(
      await namesAfterProviderDown('memo.clear <key:string>'),
      '带 inline DSL 的指令注销落空，旧注册表留着幽灵指令',
    ).not.toContain('memo.clear');
  });

  it('不带位置参数的指令照旧能注销（反向锚）', async () => {
    expect(await namesAfterProviderDown('memo.clear')).not.toContain('memo.clear');
  });
});
