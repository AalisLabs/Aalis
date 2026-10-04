import { Activity, Blocks, type LucideIcon, Settings } from 'lucide-react';
import { useAttention } from '../health/attention';
import { paths } from '../routes';

// 宿主的入口：桌面在图标栏底部，手机在第一层的会话列表上面。运行状况带「需要处理」的数，是唯一有角标的一项

export type HostArea = 'health' | 'plugins' | 'settings';

export const HOST_ENTRIES: ReadonlyArray<{ area: HostArea; label: string; icon: LucideIcon; path: string }> = [
  { area: 'health', label: '运行状况', icon: Activity, path: paths.health },
  { area: 'plugins', label: '插件', icon: Blocks, path: paths.plugins },
  { area: 'settings', label: '设置', icon: Settings, path: paths.settings },
];

/** 各入口角标上的数：运行状况是「需要处理」的数，别的入口与数为 0 时没有 */
export function useEntryCounts(): (area: HostArea) => number | undefined {
  const count = useAttention().items?.length ?? 0;
  return area => (area === 'health' && count > 0 ? count : undefined);
}

/** 带角标的入口在读屏名字后面接上数，图标栏与手机第一层同一写法 */
export const countNote = (count: number) => `（${count} 项需要处理）`;
