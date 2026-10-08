import { useEffect, useState } from 'react';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import { useSessionClient } from '../connection';
import { SESSION_PROTOCOL, useProvider } from '../plugins/list';

// 回滚一轮：只回滚文件，或连这一轮的对话一起删。回滚撤不回来，先确认，焦点落在「取消」上。确认之前先查这一轮的检查点：
// 执行过命令的写明命令的效果不会撤回（命令的副作用不经存储），没查到的写明原因，查完才能确认。这一轮有转到后台的调用的
// 写明它们在这一轮结束之后写的文件不会撤回（回合提交之后的写入不进这一轮的检查点）。
// 结果如实回报：恢复与删除了几个文件、删掉几条消息；之后的回合也改过的文件，那些改动一并撤掉了，点名写出；没能回滚的写原因。
// 对话真的删掉了的，那一轮 owner 发的文字放回输入框，不自动发，附件不放回

export interface RewindTarget {
  turnId: string;
  scope: 'code' | 'code-and-chat';
  /** 那一轮 owner 发的文字 */
  prompt?: string;
  /** 这一轮有转到后台的调用（工具卡带 taskId） */
  backgrounded: boolean;
}

const TEXT = {
  code: {
    title: '回滚这一轮的文件改动？',
    body: '这一轮改过的文件恢复成改动之前的样子。之后的回合也改过的文件，那些改动会一并撤掉。',
  },
  'code-and-chat': {
    title: '回滚这一轮的文件改动与对话？',
    body: '这一轮改过的文件恢复成改动之前的样子，这一轮的消息也从会话里删掉。之后的回合也改过的文件，那些改动会一并撤掉。',
  },
} as const;

export function RewindDialog({
  sessionId,
  target,
  restore,
  onClose,
}: {
  sessionId: string;
  target?: RewindTarget;
  restore(prompt: string): void;
  onClose(): void;
}) {
  const client = useSessionClient();
  const toast = useToast();
  const sessions = useProvider(SESSION_PROTOCOL);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<{ execUsed: boolean } | { error: string }>();

  useEffect(() => {
    setCheck(undefined);
    if (!target) return;
    let current = true;
    client.request('turn/checkpoint', { sessionId, turnId: target.turnId }).then(
      result => {
        if (current) setCheck(result);
      },
      (err: Error) => {
        if (current) setCheck({ error: err.message });
      },
    );
    return () => {
      current = false;
    };
  }, [client, sessionId, target]);

  const rewind = async ({ turnId, scope, prompt }: RewindTarget) => {
    setBusy(true);
    try {
      const result = await client.request('turn/rewind', { sessionId, turnId, scope });
      if (prompt !== undefined && (result.deletedMessages ?? 0) > 0) restore(prompt);
      const done = [
        result.restored.length > 0 && `恢复 ${result.restored.length} 个文件`,
        result.deleted.length > 0 && `删除 ${result.deleted.length} 个文件`,
        result.deletedMessages !== undefined && result.deletedMessages > 0 && `删掉 ${result.deletedMessages} 条消息`,
      ].filter(part => typeof part === 'string');
      toast({ kind: 'success', text: done.length > 0 ? `已回滚：${done.join('、')}` : '这一轮没有可以回滚的改动' });
      if (result.alsoChangedBy.length > 0) {
        const uris = result.alsoChangedBy.map(entry => entry.uri).join('、');
        toast({ kind: 'info', text: `之后的回合也改过这些文件，那些改动一并撤掉了：${uris}` });
      }
      const [first] = result.errors;
      if (first) {
        toast({
          kind: 'danger',
          text: `有 ${result.errors.length} 处没能回滚：${first.uri}（${first.reason}）`,
          source: sessions,
        });
      }
    } catch (err) {
      toast({ kind: 'danger', text: `回滚失败：${(err as Error).message}`, source: sessions });
    } finally {
      setBusy(false);
      onClose();
    }
  };

  return (
    <Dialog
      open={target !== undefined}
      title={target ? TEXT[target.scope].title : ''}
      onClose={onClose}
      footer={
        target && (
          <>
            <Button data-autofocus onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" danger busy={busy || check === undefined} onClick={() => void rewind(target)}>
              回滚
            </Button>
          </>
        )
      }
    >
      {target && <p>{TEXT[target.scope].body}</p>}
      {check && 'error' in check && (
        <p role="alert">没能确认这一轮有没有执行过命令（{check.error}）；命令的效果不会随回滚撤回。</p>
      )}
      {check && 'execUsed' in check && check.execUsed && <p>这一轮执行过命令，命令的效果不会撤回。</p>}
      {target?.backgrounded && <p>这一轮有转到后台的调用，它们在这一轮结束之后写的文件不会撤回。</p>}
    </Dialog>
  );
}
