import { describe, expect, it } from 'vitest';
import { runTscProbe } from '../helpers/tsc-probe.js';

// ════════════════════════════════════════════════════════════
// uses 里某一项写错（不是描述符，也不是 optional() 的返回值）时，编译错误只落在这一项上，
// 其余绑定照常推导。此前推导失败会退回约束类型，所有绑定都成了 never，apply 里每用一次绑定
// 就多一条「类型为 never」的连带报错。
//
// 负向用例不能放进 test/（test-types 绊线要求零错），故写到临时目录、spawn tsc、断言错误落点。
// 负向探针先确认「去掉错误就能编过」，防恒真。
// ════════════════════════════════════════════════════════════

const GOOD = `import { type BoundOf, definePlugin, events, lifecycle, logger } from '@aalis/core';

type IsAny<T> = 0 extends 1 & T ? true : false;

definePlugin({
  name: 'probe-inline',
  uses: { logger, events, lifecycle },
  apply(b) {
    b.logger.info('x');
    void b.events.on;
    void b.lifecycle.onDispose;
    const notAny: IsAny<typeof b.logger> = false;
    void notAny;
  },
});

const uses = { logger, events };
type Caps = BoundOf<typeof uses>;
function run(caps: Caps): void {
  caps.logger.info('x');
  void caps.events.on;
}
definePlugin({ name: 'probe-outer', uses, apply: run });
`;

const BAD = `import { type BoundOf, definePlugin, events, lifecycle, logger } from '@aalis/core';

definePlugin({
  name: 'probe-inline',
  uses: { logger, oops: 42, events, lifecycle }, // BAD-INLINE
  apply(b) {
    b.logger.info('x');
    void b.events.on;
    void b.lifecycle.onDispose;
  },
});

const uses = { logger, events, bad: 'x' };
type Caps = BoundOf<typeof uses>;
function run(caps: Caps): void {
  caps.logger.info('x');
  void caps.events.on;
}
definePlugin({ name: 'probe-outer', uses, apply: run }); // BAD-OUTER
`;

function lineOf(source: string, marker: string): number {
  return source.split('\n').findIndex(l => l.includes(marker)) + 1;
}

describe('uses 写错时只报那一项', () => {
  it('正向：去掉写错的项后编译通过，绑定不是 any', () => {
    const errs = runTscProbe(GOOD);
    expect(errs, `合法声明必须放行，实际：${errs.join('\n') || '（零错误）'}`).toEqual([]);
  });

  it('负向：内联与外置的 uses 各写错一项，各只报一条，apply 里没有连带报错', () => {
    const errs = runTscProbe(BAD);
    const inline = lineOf(BAD, 'BAD-INLINE');
    const outer = lineOf(BAD, 'BAD-OUTER');
    expect(errs, `应恰好两条错误，实际：\n${errs.join('\n')}`).toHaveLength(2);
    expect(errs.some(e => e.includes(`fixture.ts(${inline},`))).toBe(true);
    expect(errs.some(e => e.includes(`fixture.ts(${outer},`))).toBe(true);
    expect(errs.join('\n')).not.toMatch(/never/);
  });
});
