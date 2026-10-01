import { useState } from 'react';
import type { SchemaField } from '../types';
import { isMasked, isSecretRef } from '../utils/secret';

/**
 * secret 是这个值所属字段的 schema.secret：`true` 时引用显示为「已设置」、明文遮蔽，`false` 时不遮蔽，
 * 不写（没有 schema 的插件、分组、数组）时字符串按字段名判断。map、list 的条目随所属字段。
 * fields 是 value 下一层的字段声明：分组传它的 fields，对象数组传 items（逐个元素套用），子字段按各自的 secret 处理
 */
export function ConfigValue({ label, value, depth = 0, secret, description, defaultValue, fields }: { label: string; value: unknown; depth?: number; secret?: boolean; description?: string; defaultValue?: unknown; fields?: Record<string, SchemaField> }) {
  const [open, setOpen] = useState(depth < 1);

  // 密钥引用：值在宿主的密钥存储里，接口不给，只说已设置与键名
  if (secret === true && isSecretRef(value)) {
    const text = `已设置（键 ${value.$secret}）`;
    return (
      <div className="config-item" style={{ paddingLeft: depth * 12 }}>
        <span className="key">
          <code className="field-key">{label}</code>
          {description && <span className="field-hint"> / {description}</span>}
        </span>
        <span className="val" title={text}>{text}</span>
      </div>
    );
  }

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
              <ConfigValue key={idx} label={`#${idx + 1}`} value={item} depth={depth + 1} secret={secret} fields={fields} />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (value === null || value === undefined || typeof value !== 'object') {
    // 按字段名判断时只对字符串值打码：数字/布尔不可能是密钥
    const isSensitive = secret === true || (typeof value === 'string' && isMasked(secret, label));
    const isMissing = value === null || value === undefined;
    const usesDefault = isMissing && defaultValue !== undefined && defaultValue !== null;
    const raw = isMissing
      ? usesDefault
        ? typeof defaultValue === 'object'
          ? JSON.stringify(defaultValue)
          : String(defaultValue)
        : '-'
      : String(value);
    // 有值一律换成固定掩码，一个字符都不露：用户自定的短口令露出前几位就等于泄露了大半
    const display = isSensitive && raw !== '' && (!isMissing || usesDefault) ? '••••••' : raw;
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
  // 子值：所属字段是密钥时整个值都是；有字段声明的按声明；其余（map 的条目、分组里没声明的键）随所属字段
  const childSecret = (k: string): boolean | undefined => {
    if (secret === true) return true;
    const field = fields?.[k];
    return field ? field.secret : secret;
  };
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
            <ConfigValue key={k} label={k} value={v} depth={depth + 1} secret={childSecret(k)} />
          ))}
        </div>
      )}
    </div>
  );
}
