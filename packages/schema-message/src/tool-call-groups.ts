// ============================================================
// tool-call-groups.ts — 历史里的工具调用组
//
// 读历史的各方（agent 装载历史、会话服务的时间线、记忆摘要的归档）按同一个归组认工具调用组：组的结果按 T0+1…T0+N 记时间戳，
// 按时间戳读历史的存储（Mongo、sqlite）会把组写入期间归档的别的消息（插进来的输入、被触发判定或流控吞掉的影子归档、随后的
// 回复）排进调用与结果之间，按相邻认组就会把组拆开。
// ============================================================

import type { Message } from './index.js';

/** 历史里的一块：一组工具调用，或单独一条消息 */
export interface MessageUnit {
  /** 各条在原列表里的下标：工具组是调用在前，各条结果按找到的先后；单独一条的只有它 */
  readonly at: readonly number[];
  /**
   * complete 是结果找齐了的工具组（调用的每个 id 恰有一条结果），partial 是没找齐的，loose 是不在任何组里的工具结果，single 是
   * 别的单独一条
   */
  readonly shape: 'complete' | 'partial' | 'loose' | 'single';
}

/**
 * 按工具调用归组，次序是挪过之后的：从带工具调用的 assistant 往后找 toolCallId 对得上的结果，结果找齐、遇到下一次工具调用或
 * 对不上、重复的结果就停；其间别的消息挪到这组之后，保持各自先后
 */
export function groupToolCalls(messages: readonly Pick<Message, 'role' | 'toolCalls' | 'toolCallId'>[]): MessageUnit[] {
  const units: MessageUnit[] = [];
  for (let i = 0; i < messages.length; i++) {
    const head = messages[i];
    const ids = new Set(head.role === 'assistant' ? head.toolCalls?.map(call => call.id) : undefined);
    if (ids.size === 0) {
      units.push({ at: [i], shape: head.role === 'tool' ? 'loose' : 'single' });
      continue;
    }
    const results: number[] = [];
    const between: number[] = [];
    let j = i + 1;
    for (; j < messages.length && ids.size > 0; j++) {
      const next = messages[j];
      if (next.role === 'tool') {
        if (!next.toolCallId || !ids.delete(next.toolCallId)) break;
        results.push(j);
      } else if (next.toolCalls?.length) {
        break;
      } else {
        between.push(j);
      }
    }
    units.push({ at: [i, ...results], shape: ids.size === 0 ? 'complete' : 'partial' });
    for (const k of between) units.push({ at: [k], shape: 'single' });
    i = j - 1;
  }
  return units;
}
