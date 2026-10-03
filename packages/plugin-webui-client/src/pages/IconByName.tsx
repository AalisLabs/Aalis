import { LayoutGrid } from 'lucide-react';
import { DynamicIcon, type IconName, iconNames } from 'lucide-react/dynamic';
import { IconPending } from './PageIcon';

const KNOWN: ReadonlySet<string> = new Set(iconNames);

export default function IconByName({ name }: { name?: string }) {
  if (name === undefined || !KNOWN.has(name)) return <LayoutGrid aria-hidden />;
  return <DynamicIcon name={name as IconName} className={`lucide-${name}`} fallback={IconPending} aria-hidden />;
}
