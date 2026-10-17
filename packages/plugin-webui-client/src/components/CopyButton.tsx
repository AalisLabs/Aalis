import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { tr } from '../language';
import { IconButton } from './IconButton';

const RESULT_MS = 2_000;

/** 剪贴板只在安全上下文里有：局域网用 http 访问时没有，复制的入口就不出现 */
export const canCopy = () => window.isSecureContext && navigator.clipboard !== undefined;

/** 复制按钮：复制后两秒内图标与读屏标签写明结果；剪贴板不可用时不出现 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  /** 结果，也是读屏标签的字典键 */
  const [result, setResult] = useState<'copied' | 'copyFailed'>();

  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(undefined), RESULT_MS);
    return () => clearTimeout(timer);
  }, [result]);

  if (!canCopy()) return null;
  return (
    <IconButton
      icon={result === 'copied' ? Check : Copy}
      label={result ? tr(result) : label}
      onClick={() =>
        navigator.clipboard.writeText(text).then(
          () => setResult('copied'),
          () => setResult('copyFailed'),
        )
      }
    />
  );
}
