// 框架公用文件的收尾（tsc -p frame 之后）：样式基线原样复制；助手导入的 @aalis/schema-i18n 换成同目录下随本包带的一份，
// 即 schema-i18n 的构建产物（零依赖、浏览器可用），托管为 /frames/_base/schema-i18n/。浏览器不认裸模块名，框架里也没有
// import map；助手与它导入的这一份随本包同版本发布，不会对不上
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const out = 'dist/frame';
cpSync('frame/frame.css', join(out, 'frame.css'));
const i18n = dirname(createRequire(import.meta.url).resolve('@aalis/schema-i18n/package.json'));
cpSync(join(i18n, 'dist'), join(out, 'schema-i18n'), { recursive: true, filter: path => !/\.(?:ts|map)$/.test(path) });
const helper = join(out, 'frame.js');
const code = readFileSync(helper, 'utf-8');
const bare = "from '@aalis/schema-i18n'";
if (!code.includes(bare)) throw new Error(`${helper} 里没有导入 @aalis/schema-i18n`);
writeFileSync(helper, code.replaceAll(bare, "from './schema-i18n/index.js'"));
