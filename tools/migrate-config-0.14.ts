import { linkSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from 'yaml';

const EMPTY_ON_NULL = new Set([
  '@aalis/plugin-flow-control',
  '@aalis/plugin-trigger-policy',
  '@aalis/plugin-trigger-laya',
]);

/** 一次性转换旧作用域与名单写法，保留 YAML 注释；诊断只包含配置路径。 */
export function migratePluginConfig(source: string): { text: string; changed: string[]; manual: string[] } {
  const document = parseDocument(source);
  if (document.errors.length > 0) throw new Error('配置文件不是有效的 YAML，请先修正语法');
  if (!isMap(document.contents)) throw new Error('配置文件顶层必须是映射');
  const plugins = document.get('plugins', true);
  if (plugins === undefined) return { text: source, changed: [], manual: [] };
  if (!isMap(plugins)) throw new Error('plugins 必须是映射');
  const changed: string[] = [];
  const manual: string[] = [];
  function replace(map: YAMLMap, key: string, value: unknown, path: string, shared: boolean): void {
    const node = map.get(key, true);
    if (!(isScalar(node) || isSeq(node)) || node.anchor || shared || map.anchor) {
      manual.push(path);
      return;
    }
    const replacement = document.createNode(value);
    replacement.comment = node.comment;
    replacement.commentBefore = node.commentBefore;
    map.set(key, replacement);
    changed.push(path);
  }
  function names(map: YAMLMap, prefix: string, shared: boolean): void {
    for (const key of ['triggerNames', 'muteKeywords']) {
      const node = map.get(key, true);
      if (node === undefined || (isScalar(node) && (node.value === null || typeof node.value === 'string'))) continue;
      const path = `${prefix}.${key}`;
      // 分隔符、空白或非字符串成员不能无损转回文本，交给用户核对。
      if (
        !isSeq(node) ||
        node.items.some(
          item =>
            !isScalar(item) ||
            typeof item.value !== 'string' ||
            !item.value ||
            item.value.trim() !== item.value ||
            /[,\r\n]/.test(item.value) ||
            item.anchor ||
            item.comment ||
            item.commentBefore,
        )
      ) {
        manual.push(path);
        continue;
      }
      replace(map, key, node.items.map(item => (item as { value: string }).value).join(','), path, shared);
    }
  }
  for (const pair of plugins.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') continue;
    const id = pair.key.value;
    const name = id.split(':')[0];
    if (
      !EMPTY_ON_NULL.has(name) &&
      !['@aalis/plugin-checkpoint', '@aalis/plugin-session-manager', '@aalis/plugin-mcp-server'].includes(name)
    )
      continue;
    const path = `plugins.${id}.scopes`;
    if (!isMap(pair.value)) {
      // 配置段留空等同未配置；别名不能在不知道引用方的情况下就地修改。
      if (!(isScalar(pair.value) && pair.value.value === null)) manual.push(path);
      continue;
    }
    const shared = !!(document.contents.anchor || plugins.anchor || pair.value.anchor);
    if (name === '@aalis/plugin-mcp-server') {
      const groups = pair.value.get('toolGroups', true);
      // null 现在表示缺省（全部工具组），旧版拒绝启动；不能替用户决定暴露范围。
      if (isScalar(groups) && groups.value === null) manual.push(`plugins.${id}.toolGroups`);
      continue;
    }
    if (name === '@aalis/plugin-session-manager') {
      const profiles = pair.value.get('platformProfiles', true);
      if (isSeq(profiles))
        profiles.items.forEach((item, i) => {
          if (!isMap(item)) return;
          const think = item.get('think', true);
          if (isScalar(think) && typeof think.value === 'boolean') {
            replace(
              item,
              'think',
              think.value ? 'on' : 'off',
              `plugins.${id}.platformProfiles[${i}].think`,
              shared || !!profiles.anchor,
            );
          }
        });
      continue;
    }
    if (name === '@aalis/plugin-trigger-policy' || name === '@aalis/plugin-trigger-laya') {
      names(pair.value, `plugins.${id}`, shared);
      if (name === '@aalis/plugin-trigger-policy') {
        const overrides = pair.value.get('overrides', true);
        if (isSeq(overrides)) {
          overrides.items.forEach((item, i) => {
            if (isMap(item)) names(item, `plugins.${id}.overrides[${i}]`, shared || !!overrides.anchor);
          });
        }
      }
    }
    const node = pair.value.get('scopes', true);
    if (node === undefined || isSeq(node)) continue;
    let scopes: string[];
    if (isScalar(node) && node.value === null) {
      if (!EMPTY_ON_NULL.has(name)) continue;
      scopes = [];
    } else if (isScalar(node) && typeof node.value === 'string') {
      scopes =
        name === '@aalis/plugin-checkpoint'
          ? node.value.length === 0
            ? ['webui:*']
            : node.value
                .split(/[,\s]+/)
                .map(s => s.trim())
                .filter(Boolean)
          : node.value
              .split(',')
              .map(s => s.trim())
              .filter(Boolean);
    } else {
      manual.push(path);
      continue;
    }
    replace(pair.value, 'scopes', scopes, path, shared);
  }
  try {
    return { text: changed.length ? document.toString() : source, changed, manual };
  } catch {
    throw new Error('配置包含无法安全改写的 YAML 引用，请手动迁移');
  }
}

function main(args: string[]): void {
  const write = args[0] === '--write';
  const check = args[0] === '--check';
  if ((!write && !check) || args.length !== 2) {
    throw new Error('用法：pnpm exec tsx tools/migrate-config-0.14.ts --check|--write <配置文件>');
  }
  const file = resolve(args[1]);
  const info = lstatSync(file);
  if (!info.isFile()) throw new Error('迁移目标必须是普通文件，请直接指定原文件');
  const source = readFileSync(file, 'utf8');
  const result = migratePluginConfig(source);
  for (const path of result.changed) process.stdout.write(`需转换：${path}\n`);
  for (const path of result.manual) process.stdout.write(`需人工检查：${path}\n`);
  if (result.manual.length > 0) {
    process.exitCode = 2;
    return;
  }
  if (result.changed.length === 0) {
    process.stdout.write('无需转换\n');
    return;
  }
  if (!write) {
    process.exitCode = 1;
    return;
  }
  // 固定备份名且禁止覆盖，避免重复运行掩盖升级前的原文件。
  const temporary = mkdtempSync(join(dirname(file), '.schema-0.14-'));
  try {
    const backup = join(temporary, 'before');
    const updated = join(temporary, 'after');
    writeFileSync(backup, source, { flag: 'wx', mode: 0o600 });
    writeFileSync(updated, result.text, { flag: 'wx', mode: info.mode & 0o777 });
    // 同文件系统硬链接原子发布完整备份，且已有备份时不会覆盖。
    linkSync(backup, `${file}.before-schema-0.14`);
    renameSync(updated, file);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  process.stdout.write('转换完成，原文件已备份；请在启动前核对差异\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    // 文件系统错误只报错误码，避免错误对象携带路径或配置内容。
    const code = (error as NodeJS.ErrnoException).code;
    process.stderr.write(`${code ? `文件操作失败：${code}` : (error as Error).message}\n`);
    process.exitCode = 2;
  }
}
