import type { SecretRef } from '../types';

/** 是不是密钥引用：只有 `$secret` 一个自有键、值为非空字符串的纯对象（与 @aalis/schema-config 的 isSecretRef 同一判定） */
export function isSecretRef(value: unknown): value is SecretRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const key = (value as Record<string, unknown>).$secret;
  return keys.length === 1 && keys[0] === '$secret' && typeof key === 'string' && key !== '';
}

/** 字段名像凭据。关键词后不接字母，避免 tokenBudget / secretLength 这类合成词被误判 */
const SECRET_NAME = /(apiKey|password|secret|token)(?![a-zA-Z])/i;

/**
 * 显示与输入时是否遮蔽：schema 写了 secret 以它为准（`false` 是插件作者判断过不是凭据），
 * 没写或没有 schema 时按字段名判断
 */
export function isMasked(secret: boolean | undefined, name: string): boolean {
  return secret ?? SECRET_NAME.test(name);
}
