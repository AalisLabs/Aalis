import { describe, expect, it } from 'vitest';
import { cloneConfigObject as cloneFromCore } from '../../packages/core/src/infrastructure/config-values.js';
import { cloneConfigObject as cloneFromSchema } from '../../packages/schema-config/src/index.js';

/**
 * core 与 schema-config 都不能依赖对方，拷贝规则只能各写一份。
 * 同一组夹具喂两边：值相等、引用行为一致，改一处漏改另一处会红。
 */
describe('core / schema-config 配置拷贝规则对齐', () => {
  it('同一夹具：toEqual，纯对象不同引用，Date / class 同引用，危险键跳过', () => {
    class Token {
      constructor(readonly id: string) {}
    }
    const stamp = new Date('2020-01-01');
    const token = new Token('x');
    const fixture = JSON.parse(
      '{"plain":{"a":1},"nested":{"inner":{"b":2}},"list":[{"k":"v"}],"__proto__":{"polluted":"yes"}}',
    ) as Record<string, unknown>;
    fixture.stamp = stamp;
    fixture.token = token;

    const coreOut = cloneFromCore(fixture);
    const schemaOut = cloneFromSchema(fixture);

    expect(coreOut).toEqual(schemaOut);
    expect(coreOut).not.toBe(fixture);
    expect(schemaOut).not.toBe(fixture);
    expect(coreOut).not.toBe(schemaOut);

    const corePlain = coreOut.plain as { a: number };
    const schemaPlain = schemaOut.plain as { a: number };
    const fixturePlain = fixture.plain as { a: number };
    expect(corePlain).toEqual(fixturePlain);
    expect(corePlain).not.toBe(fixturePlain);
    expect(schemaPlain).not.toBe(fixturePlain);
    expect(corePlain).not.toBe(schemaPlain);

    const coreNested = (coreOut.nested as { inner: { b: number } }).inner;
    const schemaNested = (schemaOut.nested as { inner: { b: number } }).inner;
    const fixtureNested = (fixture.nested as { inner: { b: number } }).inner;
    expect(coreNested).toEqual(fixtureNested);
    expect(coreNested).not.toBe(fixtureNested);
    expect(schemaNested).not.toBe(fixtureNested);

    const coreList = coreOut.list as Array<{ k: string }>;
    const schemaList = schemaOut.list as Array<{ k: string }>;
    const fixtureList = fixture.list as Array<{ k: string }>;
    expect(coreList).toEqual(fixtureList);
    expect(coreList).not.toBe(fixtureList);
    expect(schemaList).not.toBe(fixtureList);
    expect(coreList[0]).not.toBe(fixtureList[0]);
    expect(schemaList[0]).not.toBe(fixtureList[0]);

    expect(coreOut.stamp).toBe(stamp);
    expect(schemaOut.stamp).toBe(stamp);
    expect(coreOut.token).toBe(token);
    expect(schemaOut.token).toBe(token);

    expect(Object.hasOwn(coreOut, '__proto__')).toBe(false);
    expect(Object.hasOwn(schemaOut, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf(coreOut)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(schemaOut)).toBe(Object.prototype);
    expect((coreOut as { polluted?: unknown }).polluted).toBeUndefined();
    expect((schemaOut as { polluted?: unknown }).polluted).toBeUndefined();
  });
});
