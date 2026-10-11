import { configure } from '@testing-library/dom';
import { vi } from 'vitest';

// 等待类工具的默认期限按负载下的机器定：vi.waitFor 与 Testing Library 的 findBy / waitFor 默认只等 1 秒，全量并行或
// 机器忙时常常不够（expect.poll 的默认值在 vitest 配置里放宽）。它们一满足条件就返回，放宽只影响失败时等多久，
// 通过的用例不会变慢。用例显式给的期限照旧生效
const WAIT_MS = 5_000;

configure({ asyncUtilTimeout: WAIT_MS });

const waitFor = vi.waitFor;
vi.waitFor = ((callback, options) =>
  waitFor(callback, typeof options === 'number' ? options : { timeout: WAIT_MS, ...options })) as typeof vi.waitFor;
