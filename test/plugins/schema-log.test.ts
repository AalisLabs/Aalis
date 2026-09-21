import { formatLogLine, type LogEntry, parseLogLine } from '@aalis/schema-log';
import { describe, expect, it } from 'vitest';

const PREFIX = '@aalis/log:1 ';
const base: LogEntry = {
  seq: 42,
  timestamp: '2026-09-21T10:20:30.000+08:00',
  level: 'warn',
  scope: 'app:worker',
  message: '记录',
};

describe('共享日志行契约', () => {
  it('新写入声明版本并保留日志字段，读取整行或去掉行尾都相同', () => {
    const line = formatLogLine(base);
    expect(line).toBe(`${PREFIX}${JSON.stringify(base)}\n`);
    expect(parseLogLine(line)).toEqual(base);
    expect(parseLogLine(line.slice(0, -1))).toEqual(base);
    expect(parseLogLine(`${line.slice(0, -1)}\r\n`)).toEqual(base);
  });

  it('字面反斜杠 n 与真实换行不混淆，CRLF、分隔符、尾空白均可无损恢复', () => {
    const entry = {
      ...base,
      scope: 'scope|with\nline\\n',
      message: 'literal \\n / real\n / CRLF\r\n / pipe | / tail \t  ',
    };
    const line = formatLogLine(entry);
    expect(parseLogLine(line.slice(0, -1))).toEqual(entry);
    expect(line.slice(0, -1)).not.toMatch(/[\r\n]/);
  });

  it('所有字符串字段支持控制字符、Unicode 和空串，不规范化时间戳', () => {
    const controls = Array.from({ length: 32 }, (_, n) => String.fromCharCode(n)).join('');
    for (const text of ['', '  \t ', controls, '\u0085\u2028\u2029', '中文 🧪 e\u0301', '\ud800', '\\n\\r\\u2028|']) {
      const entry = { ...base, timestamp: text, scope: text, message: text };
      const line = formatLogLine(entry);
      expect(line.endsWith('\n')).toBe(true);
      expect(line.slice(0, -1), JSON.stringify(text)).not.toMatch(/[\r\n\u0085\u2028\u2029]/);
      expect(parseLogLine(line), JSON.stringify(text)).toEqual(entry);
    }
  });

  it('读取既有落盘格式：保留序号、时区、消息分隔符与原有换行解码', () => {
    expect(parseLogLine('42|2026-09-21T10:20:30.000+08:00|warn|app:worker|记录 | 第二部分\\n下一行')).toEqual({
      ...base,
      message: '记录 | 第二部分\n下一行',
    });
    // 旧行无法区分字面 \\n 与真实换行；兼容读取保留既有行为，不猜测历史原文。
    expect(parseLogLine('0|timestamp|info|scope|literal\\n')?.message).toBe('literal\n');
    // 历史 parser 的宽松字段规则不因新格式校验而改变。
    expect(parseLogLine('|timestamp|legacy-level|scope|message')).toEqual({
      seq: 0,
      timestamp: 'timestamp',
      level: 'legacy-level',
      scope: 'scope',
      message: 'message',
    });
  });

  it('同一日志流可混合读取新旧记录，不丢消息尾部空白', () => {
    const old = '41|2026-09-21T10:20:29.000+08:00|info|old|历史 | 消息  \n';
    const current = { ...base, message: 'new literal\\n and real\n  ' };
    const rows = `${old}${formatLogLine(current)}`.split('\n').filter(Boolean).map(parseLogLine);
    expect(rows).toEqual([
      { seq: 41, timestamp: '2026-09-21T10:20:29.000+08:00', level: 'info', scope: 'old', message: '历史 | 消息  ' },
      current,
    ]);
  });

  it('新版本只接受合法字段，不完整对象、非有限序号与错误字段类型均拒绝', () => {
    const invalid = [
      null,
      [],
      true,
      42,
      'record',
      {},
      { ...base, seq: '42' },
      { ...base, seq: null },
      { ...base, seq: undefined },
      { ...base, timestamp: 0 },
      { ...base, scope: null },
      { ...base, message: [] },
      { ...base, level: 'fatal' },
      { ...base, level: 'INFO' },
      { ...base, level: null },
    ];
    for (const value of invalid)
      expect(parseLogLine(`${PREFIX}${JSON.stringify(value)}`), JSON.stringify(value)).toBeNull();
    expect(parseLogLine(`${PREFIX}${JSON.stringify(base).replace('42', '1e309')}`)).toBeNull();
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      const entry = { ...base, level };
      expect(parseLogLine(formatLogLine(entry))).toEqual(entry);
    }
  });

  it('损坏 JSON、未知版本与截断行返回 null，解析异常不外溢', () => {
    for (const line of [
      PREFIX,
      `${PREFIX}{`,
      `${PREFIX}{"seq":`,
      `${PREFIX}${JSON.stringify(base)} trailing`,
      `@aalis/log:2 ${JSON.stringify(base)}`,
      `@aalis/log:01 ${JSON.stringify(base)}`,
      `@aalis/log:1${JSON.stringify(base)}`,
      '@aalis/log:99 1|t|info|s|message',
      'broken|line',
      'NaN|timestamp|info|scope|message',
      'Infinity|timestamp|info|scope|message',
    ])
      expect(parseLogLine(line), line).toBeNull();
  });

  it('新格式仅返回日志字段，未知附加属性不会混入消费方对象', () => {
    const line = `${PREFIX}${JSON.stringify({ ...base, extra: 'ignored', ['__proto__']: { polluted: true } })}`;
    const entry = parseLogLine(line);
    expect(entry).toEqual(base);
    expect(Object.keys(entry!)).toEqual(['seq', 'timestamp', 'level', 'scope', 'message']);
    expect(Object.getPrototypeOf(entry)).toBe(Object.prototype);
    const input = {
      ...base,
      extra: 'ignored',
      toJSON() {
        throw new Error('不能用对象的自定义序列化替换日志记录');
      },
    };
    expect(parseLogLine(formatLogLine(input))).toEqual(base);
  });
});
