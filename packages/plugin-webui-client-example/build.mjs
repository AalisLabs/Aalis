// 极简构建：把 src/index.html 拷到 dist/index.html。
// 「前端」包的交付物就是 dist/index.html（webui-server 按 aalis.client 标记 + 该文件存在来发现并托管）。
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(resolve(here, 'dist'), { recursive: true });
copyFileSync(resolve(here, 'src/index.html'), resolve(here, 'dist/index.html'));
console.log('[webui-client-example] built dist/index.html');
