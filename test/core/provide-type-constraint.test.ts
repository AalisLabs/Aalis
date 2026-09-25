import { afterEach, describe, expect, it } from 'vitest';
import { App, definePlugin, defineService, type Logger, provide } from '../../packages/core/src/index.js';
import { runTscProbe } from '../helpers/tsc-probe.js';

// ════════════════════════════════════════════════════════════
// provide 按描述符约束实现类型：声明 increment(): number、注册返回
// string 的实现，必须在编译期被拒。入口是 uses 里的内置能力 provide，
// 签名是 provide(descriptor, impl)，不再接受服务名字符串。
//
// 负向用例不能放进 test/（test-types 绊线要求零错），故写到临时目录、
// spawn tsc、断言错误落点。负向探针先确认「去掉错误就能编过」，防恒真。
// ════════════════════════════════════════════════════════════

const GOOD = `import { definePlugin, defineService, provide } from '@aalis/core';

const x = defineService<{ increment(): number }>('x');
const impl = { increment: (): number => 1 };

definePlugin({
  name: 'probe-ok',
  provides: [x],
  uses: { provide },
  apply({ provide }) {
    provide(x, impl);
  },
});
`;

const BAD_IMPL = `import { definePlugin, defineService, provide } from '@aalis/core';

const x = defineService<{ increment(): number }>('x');

definePlugin({
  name: 'probe-bad-impl',
  provides: [x],
  uses: { provide },
  apply({ provide }) {
    provide(x, { increment: (): string => 'x' }); // BAD
  },
});
`;

const BAD_STRING = `import { definePlugin, defineService, provide } from '@aalis/core';

const x = defineService<{ increment(): number }>('x');
const impl = { increment: (): number => 1 };

definePlugin({
  name: 'probe-bad-string',
  provides: [x],
  uses: { provide },
  apply({ provide }) {
    provide('x', impl); // BAD
  },
});
`;

function badLineOf(source: string): number {
  return source.split('\n').findIndex(l => l.includes('// BAD')) + 1;
}

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

function capturingLogger() {
  const warns: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn(message: string) {
      warns.push(message);
    },
    error() {},
    child() {
      return logger;
    },
  };
  return { logger, warns };
}

describe('provide 生产者类型约束', () => {
  it('正向：describe + 匹配的 impl → 编译通过', () => {
    const errs = runTscProbe(GOOD);
    expect(errs, `合法 provide(desc, impl) 必须放行，实际：${errs.join('\n') || '（零错误）'}`).toEqual([]);
  });

  it('负向：impl 类型不合描述符的提供者类型 → 编译失败', () => {
    const good = runTscProbe(GOOD);
    expect(good, '去掉错误行后必须能编过，否则本探针恒真').toEqual([]);
    const errs = runTscProbe(BAD_IMPL);
    const line = badLineOf(BAD_IMPL);
    const atBad = errs.filter(e => e.includes(`fixture.ts(${line},`));
    expect(atBad.length, `第 ${line} 行应有类型错误，实际：${errs.join('\n') || '（零错误）'}`).toBeGreaterThan(0);
    expect(atBad.some(e => /string/.test(e) && /number/.test(e))).toBe(true);
  });

  it('负向：provide 传入服务名字符串 → 编译失败', () => {
    const good = runTscProbe(GOOD);
    expect(good, '去掉错误行后必须能编过，否则本探针恒真').toEqual([]);
    const errs = runTscProbe(BAD_STRING);
    const line = badLineOf(BAD_STRING);
    const atBad = errs.filter(e => e.includes(`fixture.ts(${line},`));
    expect(
      atBad.length,
      `第 ${line} 行应有类型错误（须传描述符而非字符串），实际：${errs.join('\n') || '（零错误）'}`,
    ).toBeGreaterThan(0);
  });

  it('负向：provide 未在 provides 声明的描述符——类型不拒，devMode 下 warn', async () => {
    // Provide 的签名不把 provides 数组收进类型参数，未声明的描述符不是类型错误；
    // 激活路径在 devMode 下对实际注册但不在 provides 里的服务名劝告。
    const undeclared = `import { definePlugin, defineService, provide } from '@aalis/core';
const x = defineService<{ n: number }>('x');
const y = defineService<{ n: number }>('y');
definePlugin({
  name: 'probe-undeclared',
  provides: [x],
  uses: { provide },
  apply({ provide }) {
    provide(y, { n: 1 });
  },
});
`;
    const typeErrs = runTscProbe(undeclared);
    expect(typeErrs, `未在 provides 声明的描述符不是类型错误，实际：${typeErrs.join('\n')}`).toEqual([]);

    const { logger, warns } = capturingLogger();
    const app = new App({
      name: 'T',
      logLevel: 'error',
      logger,
      devMode: true,
    });
    apps.push(app);
    const x = defineService<{ n: number }>('x');
    const y = defineService<{ n: number }>('y');
    await app.plugin(
      definePlugin({
        name: 'probe-undeclared',
        provides: [x],
        uses: { provide },
        apply({ provide }) {
          provide(x, { n: 1 });
          provide(y, { n: 2 });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('probe-undeclared')?.state).toBe('active');
    expect(
      warns.some(w => w.includes('y') && w.includes('未在 provides')),
      `devMode 应对未声明的 provide 出声，实际：${warns.join('\n') || '（无 warn）'}`,
    ).toBe(true);
  });
});
