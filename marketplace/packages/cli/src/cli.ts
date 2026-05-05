#!/usr/bin/env node
import { keygen } from './keygen.js';
import { publishPlugin } from './publish.js';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._ ??= '';
      out._ = String(out._ || '') + (out._ ? ' ' : '') + a;
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (cmd === 'keygen') {
    const outDir = (args.out as string) || './keys';
    const r = await keygen(outDir);
    console.log(`已生成发布者密钥对：`);
    console.log(`  publisherKeyId: ${r.publisherKeyId}`);
    console.log(`  公钥(base64):   ${r.publicKeyBase64}`);
    console.log(`  私钥文件:       ${r.privateKeyPath}`);
    console.log(`  公钥 PEM:       ${r.publicKeyPath}`);
    console.log('\n请将上述 publisherKeyId 与公钥(base64) 注册到 mock server。');
    return;
  }

  if (cmd === 'publish') {
    const pluginDir = (args._ as string) || (args.dir as string);
    if (!pluginDir) {
      console.error('用法: aalis-marketplace publish <pluginDir> --key <privateKeyPem> --keyId <publisherKeyId> [--store <dir> | --endpoint <url> --token <admin>]');
      process.exit(1);
    }
    const privateKeyPath = args.key as string;
    const publisherKeyId = args.keyId as string;
    if (!privateKeyPath || !publisherKeyId) {
      console.error('缺少 --key 或 --keyId');
      process.exit(1);
    }
    await publishPlugin({
      pluginDir,
      storeDir: args.store as string | undefined,
      endpoint: args.endpoint as string | undefined,
      privateKeyPath,
      publisherKeyId,
      adminToken: args.token as string | undefined,
    });
    return;
  }

  console.error('用法: aalis-marketplace <keygen|publish> [...]');
  process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
