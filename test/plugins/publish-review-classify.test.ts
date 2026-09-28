import { describe, expect, it, vi } from 'vitest';
import type { ChatModelRequest } from '../../packages/api-llm/src/index.js';
import {
  classifyText,
  combineVerdicts,
  parseClassification,
  reviewText,
} from '../../packages/plugin-publish-review/src/classify.js';

describe('publish review classification boundaries', () => {
  it('requires a complete structured answer and reduces unknown categories', () => {
    expect(parseClassification('{"verdict":"reject","categories":["色情","invented"],"note":"x"}')).toEqual({
      verdict: 'reject',
      categories: ['色情', '其他'],
      note: 'x',
    });
    expect(parseClassification('{"verdict":"allow","categories":[]}')).toBeUndefined();
    expect(parseClassification('allow')).toBeUndefined();
    expect(combineVerdicts(['allow', 'reject', 'unsure'])).toBe('reject');
  });

  it('extracts hidden attribute and CSS text and marks truncated reviews', () => {
    const result = reviewText(
      'title',
      'summary',
      ['assets/a.png'],
      '<p title="hidden" aria-label="secret">visible</p><style>a::before {content: "css word"}</style><script>const hiddenText="review me"</script>',
    );
    expect(result.text).toContain('hidden');
    expect(result.text).toContain('secret');
    expect(result.text).toContain('css word');
    expect(result.text).toContain('review me');
    expect(result.text).toContain('assets/a.png');
    expect(reviewText('x'.repeat(20_001), '', [], '').truncated).toBe(true);
  });

  it('cancels one hung classification after 180 seconds without retrying', async () => {
    vi.useFakeTimers();
    try {
      const chat = vi.fn((_request: ChatModelRequest) => new Promise<never>(() => {}));
      const pending = classifyText({ chat } as never, 'text', new AbortController().signal);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(await pending).toBeUndefined();
      expect(chat).toHaveBeenCalledTimes(1);
      expect(chat.mock.calls[0][0].signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
