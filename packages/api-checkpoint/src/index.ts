/**
 * @aalis/api-checkpoint — 回合检查点契约
 *
 * 一轮对话里经受控存储做的写入、删除与移动，在改动发生前备份原内容，事后可以按回合回滚。
 * 本包只有服务描述符 `checkpoint` 与对外类型，实现见 @aalis/plugin-checkpoint。
 *
 * 两类使用方：
 * - 存储实现在每次改动前探测本服务，在场就调 `beforeMutate` 留一次快照机会；
 * - 会话服务按回合回滚（会话协议的 turn/rewind），回滚之前查这一轮执行过命令没有（turn/checkpoint）。
 */

import { defineService } from '@aalis/core';

export interface CheckpointService {
  /**
   * 存储即将改动 uri 时调用，是 op 执行前的一次性快照机会。改动记进调用所在的那一轮：
   * 同一会话里同时有几轮在跑时，按写入发生在哪一轮的异步上下文里归属，不在任何一轮里的改动不记。
   * 同一 uri 在这一轮里已快照过就不再备份内容（保留最早的原始内容）；
   * 但 op='rename' 仍会补记一条不带备份的条目，否则「先改写再移走」的移动会整条丢失。
   * loadOriginal 按需读取原内容，首次需要快照时才调用；只有「不存在」与「是目录」返回 null，读不出来要抛出。
   * toUri 只对 op='rename' 有意义：改动后的目标 URI，回滚时据它把文件原路移回
   * （缺省则退化为「只把原内容写回源路径」，目标端会留一份重复）。
   */
  beforeMutate(
    uri: string,
    op: 'write' | 'delete' | 'rename',
    loadOriginal: () => Promise<{ data: Buffer; size: number } | null>,
    toUri?: string,
  ): Promise<void>;
  /**
   * 这一轮调用过命令类工具（exec、run_* 这类直接起子进程的）：它们的副作用不经存储，回滚撤不回。
   * 只看已提交的回合，与 rollback 读同一份清单；没有这一轮的清单（不在记账的会话里、已被清理、还没提交）时为 false
   */
  execUsed(sessionId: string, turnId: string): Promise<boolean>;
  /** 回滚某回合（恢复、删除、移回）；回合 id 与 agent 的回合 id 相同 */
  rollback(sessionId: string, turnId: string): Promise<RollbackResult>;
  /** 回滚某回合，并删除这一轮的对话消息与对应的向量条目 */
  rollbackWithChat(sessionId: string, turnId: string): Promise<RollbackWithChatResult>;
}

export interface RollbackResult {
  ok: boolean;
  restored: string[];
  deleted: string[];
  errors: Array<{ uri: string; reason: string }>;
  /**
   * 这一轮改过、同一会话里另有回合也改过的文件（按这一轮清单里的顺序），以及那些回合的 id（按开始时间）。
   * 在这一轮开始前就已结束的回合不算：它们的改动早于这一轮的备份，回滚不会撤掉。
   * 回滚把文件恢复成这一轮第一次改动前的内容，那些回合在这之后做的改动会一并被撤掉。回滚照常执行，这里只是如实告知。
   */
  alsoChangedBy: Array<{ uri: string; turnIds: string[] }>;
}

export interface RollbackWithChatResult extends RollbackResult {
  /** 实际从记忆里删除的消息条数 */
  deletedMessages: number;
  /** 消息删除是否成功；失败时 errors 里也记有原因 */
  chatDeleted: boolean;
}

export const checkpoint = defineService<CheckpointService>('checkpoint');
