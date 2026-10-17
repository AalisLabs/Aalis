import type { MarketplacePackage } from '@aalis/api-webui';
import { useNavigate } from 'react-router';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import { tr } from '../language';
import { isRecord, postJson } from '../rest';
import { paths } from '../routes';
import { messageOf, type PluginAction } from './action';
import { InstallDisclosure } from './disclosure';
import { usePackageManager } from './list';

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
  const source = usePackageManager();
  const install = async (name: string) => {
    await action.run(
      `install:${name}`,
      tr('installPackage', { name }),
      () => postJson('/api/marketplace/install', { name }),
      reply => {
        onClose();
        toast({ kind: 'success', text: messageOf(reply) ?? tr('installedPackage', { name }) });
        if (isRecord(reply) && typeof reply.plugin === 'string') navigate(paths.plugin(reply.plugin, 'config'));
      },
      source,
    );
    onSettled?.();
  };
  return (
    <Dialog
      open={pkg !== undefined}
      title={pkg ? tr('installConfirm', { name: pkg.name }) : ''}
      size="form"
      onClose={onClose}
      footer={
        pkg && (
          <>
            <Button data-autofocus onClick={onClose}>
              {tr('cancel')}
            </Button>
            <Button variant="primary" busy={action.busy !== undefined} onClick={() => void install(pkg.name)}>
              {tr('install')}
            </Button>
          </>
        )
      }
    >
      {pkg && (
        <>
          <InstallDisclosure name={pkg.name} />
          <p>{tr(pkg.official ? 'installFromNpm' : 'installCommunityFromNpm')}</p>
        </>
      )}
    </Dialog>
  );
}
