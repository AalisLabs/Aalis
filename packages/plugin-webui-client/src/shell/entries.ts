import { Blocks, type LucideIcon, Settings } from 'lucide-react';
import { paths } from '../routes';

// 宿主的入口：桌面在图标栏底部，手机在第一层的会话列表上面

export type HostArea = 'plugins' | 'settings';

export const HOST_ENTRIES: ReadonlyArray<{ area: HostArea; label: string; icon: LucideIcon; path: string }> = [
  { area: 'plugins', label: '插件', icon: Blocks, path: paths.plugins },
  { area: 'settings', label: '设置', icon: Settings, path: paths.settings },
];
