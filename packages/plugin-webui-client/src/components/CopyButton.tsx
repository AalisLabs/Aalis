import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { IconButton } from './IconButton';

const RESULTS = { copied: '已复制', failed: '没能复制' } as const;
const RESULT_MS = 2_000;

/** 剪贴板只在安全上下文里有：局域网用 http 访问时没有，复制的入口就不出现 */
export const canCopy = () => window.isSecureContext && navigator.clipboard !== undefined;

/** 复制按钮：复制后两秒内图标与读屏标签写明结果；剪贴板不可用时不出现 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [result, setResult] = useState<keyof typeof RESULTS>();

  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(undefined), RESULT_MS);
    return () => clearTimeout(timer);
  }, [result]);

  if (!canCopy()) return null;
  return (
    <IconButton
      icon={result === 'copied' ? Check : Copy}
      label={result ? RESULTS[result] : label}
      onClick={() =>
        navigator.clipboard.writeText(text).then(
          () => setResult('copied'),
          () => setResult('failed'),
        )
      }
    />
  );
}
