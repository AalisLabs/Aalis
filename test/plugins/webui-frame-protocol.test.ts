import { describe, expect, it } from 'vitest';
import {
  FRAME_HOST_CAPABILITIES,
  FRAME_ID_MAX_LENGTH,
  FRAME_NAME_MAX_LENGTH,
  FRAME_PROTOCOL_VERSION,
  FRAME_REQUIRED_CAPABILITY,
  FRAME_SANDBOX,
  FRAME_URL_MAX_LENGTH,
  parseFrameHello,
  parseFrameMessage,
} from '../../packages/api-webui/src/index.js';

// ════════════════════════════════════════════════════════════
// 插件前端消息通道的边界校验与能力表（api-webui 导出的纯函数与常量，宿主前端与第三方宿主前端共用）：
// 类型标记、字段类型、多余的键、字符串长度、input 是对象；实例、页面与面板的会话不在消息里，带了就是多余的键。
// 认得出请求 id 的不合格消息给出 id，宿主据它回 invalid。
// ════════════════════════════════════════════════════════════

const problemOf = (value: unknown) => {
  const result = parseFrameMessage(value);
  return result.ok ? undefined : { id: result.id, problem: result.problem };
};

describe('握手', () => {
  it('protocol 是「主.次」、nonce 是非空字符串时通过，原样给出', () => {
    const hello = { type: 'hello', protocol: FRAME_PROTOCOL_VERSION, nonce: 'n'.repeat(FRAME_ID_MAX_LENGTH) };
    expect(parseFrameHello(hello)).toEqual({ ok: true, message: hello });
  });

  it('多余的键、缺字段、版本写错、nonce 超长、不是对象、端口上的消息都不收', () => {
    const bad = [
      { type: 'hello', protocol: '1.0', nonce: 'n', instance: 'x' },
      { type: 'hello', protocol: '1.0' },
      { type: 'hello', protocol: '1', nonce: 'n' },
      { type: 'hello', protocol: 1, nonce: 'n' },
      { type: 'hello', protocol: '1.0;', nonce: 'n' },
      { type: 'hello', protocol: '1.0', nonce: 'n'.repeat(FRAME_ID_MAX_LENGTH + 1) },
      { type: 'leaving' },
      'hello',
      null,
    ];
    for (const value of bad) expect(parseFrameHello(value).ok, JSON.stringify(value)).toBe(false);
  });
});

describe('端口上的消息', () => {
  it('每种消息的合格写法通过，原样给出', () => {
    const good = [
      { type: 'data', id: 1, source: 'cards' },
      { type: 'data', id: -2, source: 'card', input: { id: 'a', nested: { x: [1] } } },
      { type: 'action', id: 3, action: 'archive', input: {} },
      { type: 'open', id: 4, target: { url: 'https://example.com/a?b#c' } },
      { type: 'open', id: 5, target: { url: 'http://127.0.0.1:9/' } },
      { type: 'open', id: 6, target: { session: 'webui:a' } },
      { type: 'sessions.list', id: 7 },
      { type: 'sessions.list', id: 8, parentId: 'webui:a', archived: true, cursor: '20', limit: 50 },
      { type: 'turn.abort', id: 9, sessionId: 'webui:a' },
      { type: 'turn.abort', id: 10, sessionId: 'webui:a', turnId: 't1' },
      { type: 'leaving' },
    ];
    for (const value of good)
      expect(parseFrameMessage(value), JSON.stringify(value)).toEqual({ ok: true, message: value });
  });

  it('实例、页面与面板的会话不在消息里：带了就是多余的键，回 invalid 要的 id 一并给出', () => {
    expect(problemOf({ type: 'data', id: 1, source: 'cards', instance: '@zz/other' })).toEqual({
      id: 1,
      problem: '多余的键：instance',
    });
    expect(problemOf({ type: 'data', id: 2, source: 'cards', pageKey: 'other' })).toEqual({
      id: 2,
      problem: '多余的键：pageKey',
    });
    expect(problemOf({ type: 'data', id: 3, source: 'cards', sessionId: 'webui:b' })).toEqual({
      id: 3,
      problem: '多余的键：sessionId',
    });
    expect(problemOf({ type: 'action', id: 4, action: 'archive', rowKey: 'a' })).toEqual({
      id: 4,
      problem: '多余的键：rowKey',
    });
    expect(problemOf({ type: 'sessions.list', id: 5, section: 'mine' })).toEqual({
      id: 5,
      problem: '多余的键：section',
    });
    expect(problemOf({ type: 'leaving', id: 6 })).toEqual({ id: 6, problem: '多余的键：id' });
  });

  it('字段类型与长度：名字、标识、地址各有上限；input 要是对象；id 要是整数', () => {
    const name = 'n'.repeat(FRAME_NAME_MAX_LENGTH);
    expect(parseFrameMessage({ type: 'data', id: 1, source: name }).ok).toBe(true);
    expect(problemOf({ type: 'data', id: 1, source: `${name}n` })).toEqual({
      id: 1,
      problem: `source 要是 1 到 ${FRAME_NAME_MAX_LENGTH} 个字符的字符串`,
    });
    expect(problemOf({ type: 'data', id: 1, source: '' })?.problem).toMatch(/^source 要是/);
    expect(problemOf({ type: 'action', id: 1, action: 7 })?.problem).toMatch(/^action 要是/);
    expect(problemOf({ type: 'turn.abort', id: 1, sessionId: 's'.repeat(FRAME_ID_MAX_LENGTH + 1) })?.problem).toMatch(
      /^sessionId 要是/,
    );
    expect(problemOf({ type: 'data', id: 1, source: 'a', input: [] })).toEqual({ id: 1, problem: 'input 要是对象' });
    expect(problemOf({ type: 'data', id: 1, source: 'a', input: null })).toEqual({ id: 1, problem: 'input 要是对象' });
    expect(problemOf({ type: 'data', id: 1, source: 'a', input: '{"id":"a"}' })).toEqual({
      id: 1,
      problem: 'input 要是对象',
    });
    expect(problemOf({ type: 'sessions.list', id: 1, archived: 'yes' })).toEqual({
      id: 1,
      problem: 'archived 要是布尔值',
    });
    expect(problemOf({ type: 'sessions.list', id: 1, limit: 1.5 })).toEqual({ id: 1, problem: 'limit 要是整数' });
    expect(problemOf({ type: 'data', id: 1.5, source: 'a' })).toEqual({ problem: 'id 要是整数' });
    expect(problemOf({ type: 'data', id: '1', source: 'a' })).toEqual({ problem: 'id 要是整数' });
    expect(problemOf({ type: 'data', source: 'a' })).toEqual({ problem: '缺少 id' });
    expect(problemOf({ type: 'turn.abort', id: 1 })).toEqual({ id: 1, problem: '缺少 sessionId' });
  });

  it('open：只收 { url } 或 { session } 之一，地址只许 http、https 的绝对地址', () => {
    const open = (target: unknown) => problemOf({ type: 'open', id: 1, target });
    expect(open({ url: 'javascript:alert(1)' })).toEqual({ id: 1, problem: 'target 只许 http、https 地址' });
    expect(open({ url: 'data:text/html,x' })?.problem).toBe('target 只许 http、https 地址');
    expect(open({ url: '/api/pages' })).toEqual({ id: 1, problem: 'target 不是绝对地址' });
    expect(open({ url: `https://example.com/${'a'.repeat(FRAME_URL_MAX_LENGTH)}` })?.problem).toBe(
      `target 要是 1 到 ${FRAME_URL_MAX_LENGTH} 个字符的字符串`,
    );
    expect(open({ url: 'https://example.com', session: 'webui:a' })?.problem).toBe(
      'target 要是 { url } 或 { session }',
    );
    expect(open({ href: 'https://example.com' })?.problem).toBe('target 要是 { url } 或 { session }');
    expect(open({})?.problem).toBe('target 要是 { url } 或 { session }');
    expect(open('https://example.com')?.problem).toBe('target 要是 { url } 或 { session }');
    expect(open({ session: '' })?.problem).toMatch(/^target 要是 1 到/);
  });

  it('不认识的消息：握手不走端口，原型上的名字不算消息', () => {
    expect(problemOf({ type: 'hello', protocol: '1.0', nonce: 'n' })).toEqual({ problem: '不认识的消息 hello' });
    expect(problemOf({ type: 'result', id: 3, ok: true, value: 1 })).toEqual({ id: 3, problem: '不认识的消息 result' });
    expect(problemOf({ type: 'constructor', id: 1 })?.problem).toBe('不认识的消息 constructor');
    expect(problemOf({ type: '__proto__', id: 1 })?.problem).toBe('不认识的消息 __proto__');
    expect(problemOf({ id: 1 })).toEqual({ id: 1, problem: '不认识的消息 undefined' });
    expect(problemOf([{ type: 'leaving' }])).toEqual({ problem: '消息要是对象' });
    expect(problemOf(undefined)).toEqual({ problem: '消息要是对象' });
  });
});

describe('能力表与常量', () => {
  it('每种请求与推送要的能力：数据源、动作与打开不要能力，宿主数据能力各管各的请求与推送', () => {
    expect(FRAME_REQUIRED_CAPABILITY).toEqual({
      data: null,
      action: null,
      open: null,
      'sessions.list': 'sessions:read',
      'turn.abort': 'turn:abort',
      'sessions.changed': 'sessions:read',
    });
    expect(FRAME_HOST_CAPABILITIES).toEqual(['sessions:read', 'turn:abort']);
  });

  it('沙箱只给脚本，协议版本是「主.次」', () => {
    expect(FRAME_SANDBOX).toBe('allow-scripts');
    expect(FRAME_PROTOCOL_VERSION).toMatch(/^\d+\.\d+$/);
  });
});
