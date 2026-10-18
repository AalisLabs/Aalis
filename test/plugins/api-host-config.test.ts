import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigSaveRefusedError,
  hostConfig,
  ownHostConfig,
  saveFailureText,
} from '../../packages/api-host-config/src/index.js';
import { type App, definePlugin } from '../../packages/core/src/index.js';
import { resolveText, toSource } from '../../packages/schema-i18n/src/index.js';
import { hostedApp } from '../fixtures/app.js';

// ════════════════════════════════════════════════════════════
// api-host-config 的只读窄面与落盘失败的说法
//
// ownHostConfig 与 hostConfig 同一个服务名、业务层不同：插件在 uses 里声明它，只读得到本实例在配置文档里那一段的复制品，
// 没有写方法，也够不到完整的提供者。saveFailureText 是落盘失败的那一句，拒写与其余失败各一句。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

/** 读本实例那一段的插件：apply 时读一次，交出读到的值与业务句柄 */
async function reader(app: App, name: string) {
  const out: { value?: Record<string, unknown>; handle?: Record<string, unknown> } = {};
  await app.plugin(
    definePlugin({
      name,
      uses: { own: ownHostConfig },
      apply({ own }) {
        out.value = own.use.get();
        out.handle = own.use as unknown as Record<string, unknown>;
      },
    }),
  );
  await app.plugins.idle();
  return out;
}

describe('ownHostConfig', () => {
  it('同一个服务名、不同的描述符对象', () => {
    expect(ownHostConfig.name).toBe(hostConfig.name);
    expect(ownHostConfig).not.toBe(hostConfig);
  });

  it('只拿得到本实例那一段；没有这一段时为空对象', async () => {
    const { app } = hostedApp({ plugins: { p: { known: 1, nested: { k: 1 } }, q: { other: true } } });
    apps.push(app);
    expect((await reader(app, 'p')).value).toEqual({ known: 1, nested: { k: 1 } });
    expect((await reader(app, 'r')).value).toEqual({});
  });

  it('是复制品：改它（含嵌套）不写穿文档', async () => {
    const { app, store } = hostedApp({ plugins: { p: { known: 1, nested: { k: 1 } } } });
    apps.push(app);
    const { value } = await reader(app, 'p');
    value!.known = 2;
    (value!.nested as Record<string, unknown>).k = 2;
    expect(store.getPluginConfig('p')).toEqual({ known: 1, nested: { k: 1 } });
  });

  it('没有写方法，原型链上够不到完整的提供者', async () => {
    const { app } = hostedApp({ plugins: { p: { known: 1 } } });
    apps.push(app);
    const { handle } = await reader(app, 'p');
    expect(Object.keys(handle!)).toEqual(['get']);
    expect(Object.getPrototypeOf(handle)).toBe(Object.prototype);
  });
});

describe('saveFailureText', () => {
  const refused = new ConfigSaveRefusedError('配置文件有尚未生效的外部修改');

  it('拒写说未写入，并按 reconcile 说之后怎样与文件对齐', () => {
    expect(toSource(saveFailureText(refused, 'reload'))).toBe(
      '已在运行态生效，但未写入配置文件（配置文件有尚未生效的外部修改）；修好该文件后会按文件内容重载',
    );
    expect(toSource(saveFailureText(refused, 'restart'))).toBe(
      '已在运行态生效，但未写入配置文件（配置文件有尚未生效的外部修改）；修好该文件后，重启时以文件内容为准',
    );
  });

  it('其余失败说写入失败、改动保留在文档里', () => {
    expect(toSource(saveFailureText(new Error('zz-disk-full'), 'reload'))).toBe(
      '已在运行态生效，但写入配置文件失败（zz-disk-full）；改动保留在文档里，下次保存成功时一并写入',
    );
  });

  it('英文', () => {
    expect(resolveText(saveFailureText(refused, 'restart'), ['en'])).toBe(
      'Applied at runtime, but not written to the config file (配置文件有尚未生效的外部修改); once the file is fixed, its contents take effect at the next restart',
    );
    expect(resolveText(saveFailureText(new Error('zz-disk-full'), 'reload'), ['en'])).toBe(
      'Applied at runtime, but writing the config file failed (zz-disk-full); the change stays in the document and is written with the next successful save',
    );
  });
});
