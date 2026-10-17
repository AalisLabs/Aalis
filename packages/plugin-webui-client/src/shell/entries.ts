import type { TextRef } from '@aalis/schema-i18n';
import { Activity, Blocks, type LucideIcon, Settings } from 'lucide-react';
import { useAttention } from '../health/attention';
import { tr } from '../language';
import { paths } from '../routes';
import { t } from '../texts';

// 宿主的入口：桌面在图标栏底部，手机在第一层的会话列表上面。运行状况带「需要处理」的数，是唯一有角标的一项

export type HostArea = 'health' | 'plugins' | 'settings';

export const HOST_ENTRIES: ReadonlyArray<{ area: HostArea; label: TextRef; icon: LucideIcon; path: string }> = [
  { area: 'health', label: t('health'), icon: Activity, path: paths.health },
  { area: 'plugins', label: t('plugins'), icon: Blocks, path: paths.plugins },
  { area: 'settings', label: t('settings'), icon: Settings, path: paths.settings },
];

/** 各入口角标上的数：运行状况是「需要处理」的数，别的入口与数为 0 时没有 */
export function useEntryCounts(): (area: HostArea) => number | undefined {
  const count = useAttention().items?.length ?? 0;
  return area => (area === 'health' && count > 0 ? count : undefined);
}

/** 入口的读屏名字：带角标的写成带上数的整句（看得见的角标要是名字的一部分），图标栏与手机第一层同一句 */
export const entryName = (label: string, count: number | undefined) =>
  count === undefined ? label : tr('entryWithCount', { name: label, count });
