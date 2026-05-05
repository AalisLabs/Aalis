import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
} from 'node:crypto';

import type { ManifestSignature, PluginManifest } from './types.js';

/** 计算文件/Buffer 的 sha256（hex）。 */
export function sha256Hex(data: Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * 将 manifest 规范化序列化以便签名/验签。
 *
 * 规则：
 *   - 排除 `signature` 字段；
 *   - 对所有 object 按 key 字典序排序；
 *   - 不输出 `undefined` 字段；
 *   - 末尾不带换行。
 */
export function canonicalizeManifest(manifest: PluginManifest): string {
  const { signature: _ignored, ...rest } = manifest;
  return canonicalize(rest);
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalize: 不支持的非有限数值');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return '[' + value.map(item => canonicalize(item)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter(k => obj[k] !== undefined)
      .sort();
    return (
      '{' +
      keys
        .map(k => JSON.stringify(k) + ':' + canonicalize(obj[k]))
        .join(',') +
      '}'
    );
  }
  if (typeof value === 'undefined') {
    throw new Error('canonicalize: undefined 不应进入序列化');
  }
  throw new Error(`canonicalize: 不支持的类型 ${typeof value}`);
}

// ---- Key pair --------------------------------------------------------------

export interface Ed25519KeyPair {
  /** PEM 格式公钥。 */
  publicKeyPem: string;
  /** PEM 格式私钥（PKCS#8）。 */
  privateKeyPem: string;
  /** raw 32-byte 公钥（base64），等同 manifest 中存储格式。 */
  publicKeyBase64: string;
}

export function generateKeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const raw = publicKey.export({ format: 'jwk' });
  // jwk.x 是 base64url 的 raw 公钥；统一转成标准 base64。
  const publicKeyBase64 = base64UrlToBase64(raw.x as string);
  return { publicKeyPem, privateKeyPem, publicKeyBase64 };
}

function base64UrlToBase64(s: string): string {
  return Buffer.from(s, 'base64url').toString('base64');
}

function base64ToKeyObject(publicKeyBase64: string) {
  // 从 raw 32-byte → spki 公钥对象
  const raw = Buffer.from(publicKeyBase64, 'base64');
  if (raw.length !== 32) {
    throw new Error(`Ed25519 公钥长度异常: ${raw.length}（应为 32）`);
  }
  // SPKI prefix for Ed25519: 302a300506032b6570032100
  const spki = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    raw,
  ]);
  return createPublicKey({ key: spki, format: 'der', type: 'spki' });
}

// ---- Sign / Verify ---------------------------------------------------------

/**
 * 用 PEM 私钥对 manifest 签名。
 * @returns 填充了 signature 的 manifest 拷贝
 */
export function signManifest(
  manifest: PluginManifest,
  privateKeyPem: string,
  publisherKeyId: string,
): PluginManifest {
  const key = createPrivateKey({ key: privateKeyPem, format: 'pem' });
  const payload = Buffer.from(canonicalizeManifest(manifest), 'utf8');
  // Ed25519 在 Node 中 algorithm 必须为 null
  const sig = nodeSign(null, payload, key);
  const signature: ManifestSignature = {
    algorithm: 'ed25519',
    publisherKeyId,
    value: sig.toString('base64'),
  };
  return { ...manifest, signature };
}

/**
 * 验签：传入 manifest 与可信公钥（base64 raw），返回是否通过。
 * 不通过会返回 false 而非抛错；调用方负责区分"无签名"与"签名错误"。
 */
export function verifyManifest(
  manifest: PluginManifest,
  publicKeyBase64: string,
): boolean {
  if (!manifest.signature) return false;
  if (manifest.signature.algorithm !== 'ed25519') return false;
  try {
    const key = base64ToKeyObject(publicKeyBase64);
    const payload = Buffer.from(canonicalizeManifest(manifest), 'utf8');
    const sig = Buffer.from(manifest.signature.value, 'base64');
    return nodeVerify(null, payload, key, sig);
  } catch {
    return false;
  }
}
