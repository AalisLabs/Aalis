import { describe, expect, it } from 'vitest';
import { parseDsmlToolCalls } from '../../packages/plugin-deepseek/src/dsml-parser.js';

// 全角竖线 U+FF5C
const FW = '｜';

describe('parseDsmlToolCalls', () => {
  it('parses standard single-pipe DSML block with single invoke', () => {
    const text = `<${FW}DSML${FW}tool_calls><${FW}DSML${FW}invoke name="web_search"><${FW}DSML${FW}parameter name="query" string="true">aalis github</${FW}DSML${FW}parameter></${FW}DSML${FW}invoke></${FW}DSML${FW}tool_calls>`;
    const calls = parseDsmlToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe('function');
    expect(calls[0].function.name).toBe('web_search');
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ query: 'aalis github' });
    expect(calls[0].id).toMatch(/^call_dsml_/);
  });

  it('parses double-pipe malformed variant (the observed leak)', () => {
    const text = `<${FW}${FW}DSML${FW}${FW}tool_calls><${FW}${FW}DSML${FW}${FW}invoke name="user_relation_search_persons"><${FW}${FW}DSML${FW}${FW}parameter name="keyword" string="true">Alice</${FW}${FW}DSML${FW}${FW}parameter><${FW}${FW}DSML${FW}${FW}parameter name="limit" string="true">5</${FW}${FW}DSML${FW}${FW}parameter></${FW}${FW}DSML${FW}${FW}invoke></${FW}${FW}DSML${FW}${FW}tool_calls>`;
    const calls = parseDsmlToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('user_relation_search_persons');
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ keyword: 'Alice', limit: '5' });
  });

  it('parses half-width pipe variant', () => {
    const text = `<|DSML|tool_calls><|DSML|invoke name="get_weather"><|DSML|parameter name="city" string="true">Tokyo</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>`;
    const calls = parseDsmlToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('get_weather');
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ city: 'Tokyo' });
  });

  it('parses multiple invokes in one block', () => {
    const text =
      `<${FW}DSML${FW}tool_calls>` +
      `<${FW}DSML${FW}invoke name="A"><${FW}DSML${FW}parameter name="x" string="true">1</${FW}DSML${FW}parameter></${FW}DSML${FW}invoke>` +
      `<${FW}DSML${FW}invoke name="B"><${FW}DSML${FW}parameter name="y" string="true">2</${FW}DSML${FW}parameter></${FW}DSML${FW}invoke>` +
      `</${FW}DSML${FW}tool_calls>`;
    const calls = parseDsmlToolCalls(text);
    expect(calls).toHaveLength(2);
    expect(calls.map(c => c.function.name)).toEqual(['A', 'B']);
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ x: '1' });
    expect(JSON.parse(calls[1].function.arguments)).toEqual({ y: '2' });
  });

  it('handles invoke with no parameters', () => {
    const text = `<${FW}DSML${FW}tool_calls><${FW}DSML${FW}invoke name="ping"></${FW}DSML${FW}invoke></${FW}DSML${FW}tool_calls>`;
    const calls = parseDsmlToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('ping');
    expect(calls[0].function.arguments).toBe('{}');
  });

  it('handles parameter without string="true" attribute', () => {
    const text = `<${FW}DSML${FW}invoke name="X"><${FW}DSML${FW}parameter name="y">42</${FW}DSML${FW}parameter></${FW}DSML${FW}invoke>`;
    const calls = parseDsmlToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ y: '42' });
  });

  it('dedups identical invocations', () => {
    const text =
      `<${FW}DSML${FW}invoke name="A"><${FW}DSML${FW}parameter name="x" string="true">1</${FW}DSML${FW}parameter></${FW}DSML${FW}invoke>` +
      `<${FW}DSML${FW}invoke name="A"><${FW}DSML${FW}parameter name="x" string="true">1</${FW}DSML${FW}parameter></${FW}DSML${FW}invoke>`;
    const calls = parseDsmlToolCalls(text);
    expect(calls).toHaveLength(1);
  });

  it('preserves multiline parameter values', () => {
    const text = `<${FW}DSML${FW}invoke name="run"><${FW}DSML${FW}parameter name="code" string="true">line1\nline2\nline3</${FW}DSML${FW}parameter></${FW}DSML${FW}invoke>`;
    const calls = parseDsmlToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ code: 'line1\nline2\nline3' });
  });

  it('returns empty array on text without DSML', () => {
    expect(parseDsmlToolCalls('普通回答，不含特殊标记')).toEqual([]);
    expect(parseDsmlToolCalls('')).toEqual([]);
  });

  it('returns empty array on broken DSML (no closing invoke tag)', () => {
    const text = `<${FW}DSML${FW}invoke name="A"><${FW}DSML${FW}parameter name="x" string="true">1`;
    expect(parseDsmlToolCalls(text)).toEqual([]);
  });

  it('handles prefix text before DSML block', () => {
    const text = `这是模型多嘴的前缀。<${FW}${FW}DSML${FW}${FW}invoke name="A"><${FW}${FW}DSML${FW}${FW}parameter name="x" string="true">1</${FW}${FW}DSML${FW}${FW}parameter></${FW}${FW}DSML${FW}${FW}invoke>`;
    const calls = parseDsmlToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('A');
  });
});
