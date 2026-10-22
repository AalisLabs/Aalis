import { useState } from 'react';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import { useSessionClient } from '../connection';
import { text, tr } from '../language';
import { SESSION_PROTOCOL, useProvider } from '../plugins/list';
import { t } from '../texts';

// 回滚一轮：只回滚文件，或连这一轮的对话一起删。回滚撤不回来，先确认，焦点落在「取消」上。确认里固定写明只撤回经存储的
// 文件改动，命令与外部工具的效果撤不回；这一轮有转到后台的调用的另写明它们在这一轮结束之后写的文件不会撤回（回合提交之后的
// 写入不进这一轮的检查点）。
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
  code: { title: t('rewindCodeTitle'), body: t('rewindCodeBody') },
  'code-and-chat': { title: t('rewindChatTitle'), body: t('rewindChatBody') },
};

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

  const rewind = async ({ turnId, scope, prompt }: RewindTarget) => {
    setBusy(true);
    try {
      const result = await client.request('turn/rewind', { sessionId, turnId, scope });
      if (prompt !== undefined && (result.deletedMessages ?? 0) > 0) restore(prompt);
      const changes = [
        result.restored.length > 0 && t('rewindRestored', { count: result.restored.length }),
        result.deleted.length > 0 && t('rewindDeletedFiles', { count: result.deleted.length }),
        result.deletedMessages !== undefined &&
          result.deletedMessages > 0 &&
          t('rewindDeletedMessages', { count: result.deletedMessages }),
      ].filter(part => part !== false);
      toast({ kind: 'success', text: changes.length > 0 ? tr('rewound', { changes }) : tr('rewindNothing') });
      if (result.alsoChangedBy.length > 0) {
        toast({ kind: 'info', text: tr('rewindAlsoChanged', { uris: result.alsoChangedBy.map(entry => entry.uri) }) });
      }
      const [first] = result.errors;
      if (first) {
        toast({
          kind: 'danger',
          text: tr('rewindErrors', { count: result.errors.length, uri: first.uri, reason: first.reason }),
          source: sessions,
        });
      }
    } catch (err) {
      toast({
        kind: 'danger',
        text: tr('actionFailed', { action: t('rewind'), error: (err as Error).message }),
        source: sessions,
      });
    } finally {
      setBusy(false);
      onClose();
    }
  };

  return (
    <Dialog
      open={target !== undefined}
      title={target ? text(TEXT[target.scope].title) : ''}
      onClose={onClose}
      footer={
        target && (
          <>
            <Button data-autofocus onClick={onClose}>
              {tr('cancel')}
            </Button>
            <Button variant="primary" danger busy={busy} onClick={() => void rewind(target)}>
              {tr('rewind')}
            </Button>
          </>
        )
      }
    >
      {target && <p>{text(TEXT[target.scope].body)}</p>}
      {target && <p>{tr('rewindLimits')}</p>}
      {target?.backgrounded && <p>{tr('rewindBackgrounded')}</p>}
    </Dialog>
  );
}
