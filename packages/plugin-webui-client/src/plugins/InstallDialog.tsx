import type { MarketplacePackage } from '@aalis/api-webui';
import { useNavigate } from 'react-router';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import { isRecord, postJson } from '../rest';
import { paths } from '../routes';
import { messageOf, type PluginAction } from './action';
import { InstallDisclosure } from './disclosure';

interface InstallDialogProps {
  /** 要装的包；没有时确认框关着 */
  pkg?: Pick<MarketplacePackage, 'name' | 'official'>;
  action: PluginAction;
  onClose(): void;
  /** 装完（无论成败）之后 */
  onSettled?(): void;
}

/** 装一个包：先确认（依赖披露与来源提示），装上插件后跳到它详情的配置区。市场与「开始使用」用同一个 */
export function InstallDialog({ pkg, action, onClose, onSettled }: InstallDialogProps) {
  const toast = useToast();
  const navigate = useNavigate();
  const install = async (name: string) => {
    await action.run(
      `安装 ${name}`,
      () => postJson('/api/marketplace/install', { name }),
      reply => {
        onClose();
        toast({ kind: 'success', text: messageOf(reply) ?? `已安装 ${name}` });
        if (isRecord(reply) && typeof reply.plugin === 'string') navigate(paths.plugin(reply.plugin, 'config'));
      },
    );
    onSettled?.();
  };
  return (
    <Dialog
      open={pkg !== undefined}
      title={pkg ? `安装「${pkg.name}」？` : ''}
      size="form"
      onClose={onClose}
      footer={
        pkg && (
          <>
            <Button data-autofocus onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" busy={action.busy !== undefined} onClick={() => void install(pkg.name)}>
              安装
            </Button>
          </>
        )
      }
    >
      {pkg && (
        <>
          <InstallDisclosure name={pkg.name} />
          <p>{`从 npm 安装${pkg.official ? '' : '第三方社区的包'}。装上后它以你授予的能力运行，请确认来源可信。`}</p>
        </>
      )}
    </Dialog>
  );
}
