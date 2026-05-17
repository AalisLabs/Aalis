import { useState } from 'react';

export function ConfigValue({ label, value, depth = 0, secret, description, defaultValue }: { label: string; value: unknown; depth?: number; secret?: boolean; description?: string; defaultValue?: unknown }) {
  const [open, setOpen] = useState(depth < 1);

  // 数组：每项展开为 #1, #2, ...
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return (
        <div className="config-item" style={{ paddingLeft: depth * 12 }}>
          <span className="key">
            <code className="field-key">{label}</code>
            {description && <span className="field-hint"> / {description}</span>}
          </span>
          <span className="val">(空)</span>
        </div>
      );
    }
    return (
      <div className="config-nested" style={{ paddingLeft: depth * 12 }}>
        <div className="config-nested-header" onClick={() => setOpen(o => !o)}>
          <span className={`config-block-toggle ${open ? 'open' : ''}`}>▶</span>
          <span className="key">
            <code className="field-key">{label}</code>
            {description && <span className="field-hint"> / {description}</span>}
          </span>
          <span className="config-nested-count">{value.length} 项</span>
        </div>
        {open && (
          <div className="config-nested-body">
            {value.map((item, idx) => (
              <ConfigValue key={idx} label={`#${idx + 1}`} value={item} depth={depth + 1} secret={secret} />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (value === null || value === undefined || typeof value !== 'object') {
    // 仅对字符串值打码；数字/布尔不可能是密钥。
    // 字段名正则要求关键词后不接字母，避免 memoryTokenBudget / secretLength 这类合成词被误判。
    const isSensitive =
      secret || (typeof value === 'string' && /(apiKey|password|secret|token)(?![a-zA-Z])/i.test(label));
    const isMissing = value === null || value === undefined;
    const usesDefault = isMissing && defaultValue !== undefined && defaultValue !== null;
    const raw = isMissing
      ? usesDefault
        ? typeof defaultValue === 'object'
          ? JSON.stringify(defaultValue)
          : String(defaultValue)
        : '-'
      : String(value);
    const display = isSensitive && raw.length > 4 ? raw.slice(0, 4) + '••••••' : raw;
    return (
      <div className="config-item" style={{ paddingLeft: depth * 12 }}>
        <span className="key">
          <code className="field-key">{label}</code>
          {description && <span className="field-hint"> / {description}</span>}
        </span>
        <span className="val" title={isSensitive ? '••••••' : raw}>
          {display}
          {usesDefault && <span className="field-hint"> (默认)</span>}
        </span>
      </div>
    );
  }

  const entries = Object.entries(value as Record<string, unknown>);
  return (
    <div className="config-nested" style={{ paddingLeft: depth * 12 }}>
      <div className="config-nested-header" onClick={() => setOpen(o => !o)}>
        <span className={`config-block-toggle ${open ? 'open' : ''}`}>▶</span>
        <span className="key">{label}</span>
        <span className="config-nested-count">{entries.length} 项</span>
      </div>
      {open && (
        <div className="config-nested-body">
          {entries.map(([k, v]) => (
            <ConfigValue key={k} label={k} value={v} depth={depth + 1} secret={secret} />
          ))}
        </div>
      )}
    </div>
  );
}
