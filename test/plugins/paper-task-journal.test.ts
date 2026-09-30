import { describe, expect, it, vi } from 'vitest';
import { TaskJournal } from '../../packages/plugin-paper/src/task-journal.js';
import { memoryStorage, type PaperFiles } from '../fixtures/paper.js';

const TASK = 't-1234abcd';
const OTHER = 't-deadbeef';

function setup(files: PaperFiles = new Map()) {
  const storage = memoryStorage(files);
  const warn = vi.fn();
  const journal = new TaskJournal(storage, { warn }, () => 1234);
  return { files, storage, warn, journal };
}

function parse(raw: string): Array<Record<string, unknown>> {
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

describe('TaskJournal', () => {
  it('keeps same-millisecond order and keyed replays idempotent across instances', async () => {
    const { files, storage, journal } = setup();
    const first = { type: 'remote_event', text: '原文\n第二行' };
    expect(await journal.record(TASK, 'run-1:event-1', first)).toBe(true);
    first.text = 'changed';
    expect(await journal.record(TASK, undefined, { type: 'host', count: 2 })).toBe(true);
    expect(await journal.record(TASK, 'run-1:event-2', { type: 'remote_event', count: 3 })).toBe(true);
    const original = await journal.read(TASK);
    const restarted = new TaskJournal(storage, { warn: vi.fn() }, () => 1234);
    expect(await restarted.record(TASK, 'run-1:event-1', { type: 'different' })).toBe(true);
    expect(await restarted.read(TASK)).toBe(original);
    expect(parse(original).map(e => e.order)).toEqual([1, 2, 3]);
    expect((parse(original)[0].entry as Record<string, unknown>).text).toBe('原文\n第二行');
    expect(files.size).toBe(3);
    expect(await restarted.recent(TASK, 2)).toBe(`${original.trim().split('\n').slice(-2).join('\n')}\n`);
  });

  it('reports a failed write, continues, persists a sequence gap, and retries on flush', async () => {
    const { storage, warn, journal } = setup();
    const write = storage.writeFile.bind(storage);
    let fail = true;
    storage.writeFile = async (uri, data) => {
      if (fail && uri.includes('000000000001')) throw new Error('private storage details');
      await write(uri, data);
    };
    expect(await journal.record(TASK, 'run:e1', { type: 'first' })).toBe(false);
    expect(await journal.record(TASK, 'run:e2', { type: 'second' })).toBe(true);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private storage details');
    const restarted = new TaskJournal(storage, { warn: vi.fn() }, () => 1234);
    expect(parse(await restarted.read(TASK))[0]).toMatchObject({
      type: 'task_journal_incomplete',
      reason: 'missing_sequence',
    });
    expect(parse(await restarted.recent(TASK, 1))[0]).toMatchObject({
      type: 'task_journal_incomplete',
      reason: 'missing_sequence',
    });
    fail = false;
    await journal.flush();
    expect(parse(await journal.read(TASK)).map(e => e.order)).toEqual([1, 2]);
  });

  it('retains events when the initial directory listing fails and retries them before later events', async () => {
    const { storage, journal } = setup();
    const list = storage.list.bind(storage);
    let unavailable = true;
    storage.list = async (...args) => {
      if (unavailable) throw new Error('temporary I/O failure');
      return list(...args);
    };
    expect(await journal.record(TASK, 'run:e1', { type: 'first' })).toBe(false);
    expect(await journal.flush(TASK)).toBe(false);
    unavailable = false;
    expect(await journal.record(TASK, 'run:e2', { type: 'second' })).toBe(true);
    expect(await journal.flush(TASK)).toBe(true);
    expect(parse(await journal.read(TASK)).map(row => [row.order, row.entry])).toEqual([
      [1, { type: 'first' }],
      [2, { type: 'second' }],
    ]);
    expect(await journal.record(TASK, 'run:e1', { type: 'replay' })).toBe(true);
    expect(parse(await journal.read(TASK))).toHaveLength(2);
  });

  it('contains task IDs and key text, lists retained logs, and removes only the selected task', async () => {
    const { files, journal } = setup();
    await journal.record(TASK, '../other/key', { ['__proto__']: { safe: true }, value: 1 });
    await journal.record(OTHER, 'key', { value: 2 });
    expect([...files.keys()].every(uri => uri.startsWith('pluginData:/paper/task-logs/'))).toBe(true);
    expect([...files.keys()].every(uri => !uri.includes('other/key'))).toBe(true);
    expect(await journal.list()).toEqual(
      [
        { taskId: TASK, entries: 1 },
        { taskId: OTHER, entries: 1 },
      ].sort((a, b) => a.taskId.localeCompare(b.taskId)),
    );
    expect(() => journal.uri('t-1234abcd/../../ledger.json')).toThrow();
    expect(() => journal.remove('../paper')).toThrow();
    await journal.remove(TASK);
    expect(await journal.list()).toEqual([{ taskId: OTHER, entries: 1 }]);
    expect(parse(await journal.read(OTHER))[0].entry).toEqual({ value: 2 });
  });

  it('marks an oversized recent preview without truncating the full JSONL', async () => {
    const { journal } = setup();
    await journal.record(TASK, 'large', { text: 'x'.repeat(9000) });
    expect(parse(await journal.recent(TASK))[0]).toMatchObject({ type: 'task_journal_preview_truncated' });
    expect((parse(await journal.read(TASK))[0].entry as Record<string, unknown>).text).toBe('x'.repeat(9000));
  });

  it('reads only recent files and rejects an oversized full download before reading any body', async () => {
    const { storage, journal } = setup();
    for (let i = 0; i < 6; i++) await journal.record(TASK, `run:${i}`, { text: `event-${i}` });
    const read = storage.readFile.bind(storage);
    const calls: string[] = [];
    storage.readFile = async (uri, encoding) => {
      calls.push(uri);
      return read(uri, encoding);
    };
    expect(parse(await journal.recent(TASK, 2)).map(e => (e.entry as Record<string, unknown>).text)).toEqual([
      'event-4',
      'event-5',
    ]);
    expect(calls).toHaveLength(2);
    calls.length = 0;
    await expect(journal.read(TASK, 1)).rejects.toThrow('Task journal exceeds 1 byte read limit');
    expect(calls).toHaveLength(0);
  });
});
