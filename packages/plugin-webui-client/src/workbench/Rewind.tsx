import { useState } from 'react';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import { useSessionClient } from '../connection';

// 回滚一轮：只回滚文件，或连这一轮的对话一起删。回滚撤不回来，先确认，焦点落在「取消」上。
// 结果如实回报：恢复与删除了几个文件、删掉几条消息；之后的回合也改过的文件，那些改动一并撤掉了，点名写出；没能回滚的写原因

export interface RewindTarget {
  turnId: string;
  scope: 'code' | 'code-and-chat';
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
  onClose,
}: {
  sessionId: string;
  target?: RewindTarget;
  onClose(): void;
}) {
  const client = useSessionClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const rewind = async ({ turnId, scope }: RewindTarget) => {
    setBusy(true);
    try {
      const result = await client.request('turn/rewind', { sessionId, turnId, scope });
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
        toast({ kind: 'error', text: `有 ${result.errors.length} 处没能回滚：${first.uri}（${first.reason}）` });
      }
    } catch (err) {
      toast({ kind: 'error', text: `回滚失败：${(err as Error).message}` });
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
            <Button variant="primary" danger busy={busy} onClick={() => void rewind(target)}>
              回滚
            </Button>
          </>
        )
      }
    >
      {target && TEXT[target.scope].body}
    </Dialog>
  );
}
