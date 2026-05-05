import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { generateKeyPair } from '@aalis-marketplace/protocol';

export interface KeygenResult {
  publisherKeyId: string;
  publicKeyBase64: string;
  publicKeyPath: string;
  privateKeyPath: string;
}

export async function keygen(outDir: string): Promise<KeygenResult> {
  const keys = generateKeyPair();
  const publisherKeyId = `pub_${randomUUID().slice(0, 12)}`;
  const dir = resolve(outDir);
  await mkdir(dir, { recursive: true });
  const privateKeyPath = resolve(dir, `${publisherKeyId}.private.pem`);
  const publicKeyPath = resolve(dir, `${publisherKeyId}.public.pem`);
  await writeFile(privateKeyPath, keys.privateKeyPem, { mode: 0o600 });
  await writeFile(publicKeyPath, keys.publicKeyPem);
  await writeFile(
    resolve(dir, `${publisherKeyId}.public.b64`),
    keys.publicKeyBase64 + '\n',
  );
  return {
    publisherKeyId,
    publicKeyBase64: keys.publicKeyBase64,
    publicKeyPath,
    privateKeyPath,
  };
}
