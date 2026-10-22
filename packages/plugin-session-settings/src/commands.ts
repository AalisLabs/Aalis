// ════════════════════════════════════════════════════════════
// 在聊天里看与改设置：/session、/session.set、/session.reset，以及父会话改子会话设置的 setAs（就是 /session.set 写本会话层的
// 那一段）。
//
// 门槛取「项的门槛」与「写在哪一层的门槛」两者中较高的。项的门槛是能力 setting:<实例 id>/<键>，默认按声明的 minLevel（没写即只有
// owner），交给权限服务的 authorize 裁决，owner 在「操作门槛」里改过的按改过的；层的门槛固定、经 meetsLevel 裁决：本会话不另设，
// 群与私聊的场所 2 级，工作区场所与平台类型档、平台档、全局只有 owner。所有会话一律判；权限服务不在时一律拒绝。
// 项与值的写入校验都在提供者的 update 里，这里不做 narrowest 之类的预检，update 拒收时把原因写进回执。
// ════════════════════════════════════════════════════════════

import type { UserIdentity } from '@aalis/api-authority';
import type { CommandArgv } from '@aalis/api-commands';
import { saveFailureText } from '@aalis/api-host-config';
import { placeLabel, sessionLabel } from '@aalis/api-session-manager';
import {
  isSessionSettingsError,
  layerLabel,
  SESSION_LAYERS,
  type SessionAt,
  type SessionLayerName,
  type SessionSettingsLayer,
  type SessionSource,
} from '@aalis/api-session-settings';
import { readFieldValue } from '@aalis/schema-config';
import { type TextRef, textLines, textOf } from '@aalis/schema-i18n';
import type { Caps } from './caps.js';
import type { Field, Item, SessionContext, SessionSettingsProvider } from './provider.js';
import { fixedChoices, readText, writeText } from './text-values.js';
import { t } from './texts.js';

/** --at 收的层：层表从窄到宽 */
const AT_LAYERS = [...SESSION_LAYERS].reverse().map(layer => layer.name);

/** 发出者的授权身份 */
type Identity = { platform: string; userId?: string };

/** 一次写入的目标：写到哪、称呼、层的门槛（0 不另设，Infinity 只有 owner）与这一层收哪些项 */
interface Target {
  to: { sessionId: string } | { layer: SessionSettingsLayer };
  label: string | TextRef;
  minLevel: number;
  accepts(field: Field): boolean;
}

/** 回执 */
type Receipt = { ok: boolean; text: TextRef };

const refuse = (text: string | TextRef): Receipt => ({
  ok: false,
  text: typeof text === 'string' ? textLines([text]) : text,
});

export class SettingsEditor {
  constructor(
    private readonly provider: SessionSettingsProvider,
    private readonly caps: Caps,
  ) {}

  private get sm() {
    return this.caps.sessionManager.use;
  }

  /** 这个会话里写到 name 这一层的目标；这个会话没有这一层时给出原因 */
  private target(sessionId: string, at: SessionAt, name: SessionLayerName): Target | TextRef {
    const ctx = this.provider.contextOf(sessionId, at);
    const { platform, type, place } = ctx;
    const owners = Number.POSITIVE_INFINITY;
    const make = (to: Target['to'], minLevel: number): Target => ({
      to,
      label: this.layerText(name, ctx),
      minLevel,
      accepts: this.provider.acceptsAt(name, ctx),
    });
    switch (name) {
      case 'session':
        return make({ sessionId }, 0);
      case 'place':
        if (!place) return t('notFiled');
        return make({ layer: { scope: 'place', key: place.key } }, place.kind === 'window' ? 2 : owners);
      case 'platformType':
        if (type === undefined || platform === undefined) return t('noPlatformType');
        return make({ layer: { scope: 'platformType', platform, type } }, owners);
      case 'platform':
        return make({ layer: { scope: 'platform', platform: platform ?? '' } }, owners);
      case 'global':
        return make({ layer: { scope: 'global' } }, owners);
    }
  }

  /** 一层的称呼：平台档、平台类型档与场所另写这个会话取的是哪一份；平台类型写声明的显示名，没声明时写类型名 */
  private layerText(name: SessionLayerName, { platform = '', type = '', place }: SessionContext): string | TextRef {
    switch (name) {
      case 'platform':
        return t('namedLayer', { layer: layerLabel(name), name: platform });
      case 'platformType':
        return t('platformTypeLayer', {
          layer: layerLabel(name),
          platform,
          type: this.provider.typeLabel(platform, type) ?? type,
        });
      case 'place':
        return place ? this.placeText(place.key) : layerLabel(name);
      default:
        return layerLabel(name);
    }
  }

  private placeText(key: string): TextRef {
    const record = this.sm.getPlace(key);
    return t('placeLayer', { layer: layerLabel('place'), name: record ? placeLabel(record) : key });
  }

  /** 指令里怎么写这一项：同名的写成 <实例 id>/<键> */
  private nameOf({ plugin, key }: Pick<Item, 'plugin' | 'key'>): string {
    return this.provider.items().filter(other => other.key === key).length > 1 ? `${plugin}/${key}` : key;
  }

  /** 按项名认项：写成 <实例 id>/<键> 的按全名，只写键的要唯一；重名时给出全部同名的 */
  private find(text: string): Item | Item[] | undefined {
    const items = this.provider.items();
    const exact = items.find(item => `${item.plugin}/${item.key}` === text);
    if (exact) return exact;
    const named = items.filter(item => item.key === text);
    return named.length === 1 ? named[0] : named.length > 1 ? named : undefined;
  }

  /** 项的门槛与层的门槛都过才写：没过时给出原因 */
  private denied(
    identity: Identity,
    item: Pick<Item, 'plugin' | 'key' | 'field'>,
    target: Target,
  ): string | TextRef | null {
    const authority = this.caps.authority.use;
    const itemDenied = authority.authorize(identity, {
      capability: `setting:${item.plugin}/${item.key}`,
      visibility: 'restricted',
      minLevel: item.field.session.minLevel ?? Number.POSITIVE_INFINITY,
    });
    if (itemDenied) return itemDenied;
    // 项的门槛已挡掉封禁的身份，层的门槛为 0 时这里恒过
    if (authority.meetsLevel(identity, target.minLevel)) return null;
    return target.minLevel === Number.POSITIVE_INFINITY
      ? t('layerOwnerOnly', { layer: target.label })
      : t('layerLevel', { layer: target.label, level: target.minLevel });
  }

  /** 这个身份在这一层能改的项 */
  private editable(identity: Identity, target: Target): Item[] {
    return this.provider.items().filter(item => target.accepts(item.field) && !this.denied(identity, item, target));
  }

  private editableLine(identity: Identity, target: Target): TextRef {
    const items = this.editable(identity, target).map(item => this.nameOf(item));
    return items.length > 0
      ? t('editable', { layer: target.label, items })
      : t('noneEditable', { layer: target.label });
  }

  /** 认项、判门槛；不成时给出回执 */
  private resolve(identity: Identity, target: Target, text: string): Item | Receipt {
    const found = this.find(text);
    if (Array.isArray(found)) {
      return refuse(t('ambiguous', { item: text, items: found.map(item => `${item.plugin}/${item.key}`) }));
    }
    if (!found) return refuse(textLines([t('noSuchItem', { item: text }), this.editableLine(identity, target)]));
    const denied = this.denied(identity, found, target);
    return denied ? refuse(denied) : found;
  }

  /** 写一项，回执写这次改成了什么；落盘失败时另写那一句 */
  private async write(identity: Identity, target: Target, item: Item, value: unknown): Promise<Receipt> {
    let saveError: unknown;
    try {
      ({ saveError } = await this.provider.update(target.to, { plugin: item.plugin, key: item.key, value }));
    } catch (err) {
      if (!isSessionSettingsError(err)) throw err;
      return refuse(textLines([textOf(err), this.editableLine(identity, target)]));
    }
    const name = this.nameOf(item);
    const done =
      value === null
        ? t('resetDone', {
            layer: target.label,
            items: [name],
            global: 'layer' in target.to && target.to.layer.scope === 'global' ? 'yes' : 'no',
          })
        : t('setDone', { layer: target.label, item: name, value: writeText(item.field, value) });
    return { ok: true, text: saveError === undefined ? done : textLines([done, saveFailureText(saveError, 'reload')]) };
  }

  /** 静态可选项另列一行 */
  private withChoices(text: TextRef, field: Field): TextRef {
    const choices = fixedChoices(field);
    return choices ? textLines([text, t('choices', { choices })]) : text;
  }

  /**
   * 以 identity 的身份在 sessionId 这个会话里把 itemText 写到 layer 这一层（缺省本会话），值是 valueText 的文字读法。
   * 会话管理还没收录的会话写本会话层之前先建档
   */
  async set(
    identity: Identity,
    sessionId: string,
    at: SessionAt,
    layer: SessionLayerName,
    itemText: string | undefined,
    valueText: string | undefined,
  ): Promise<Receipt> {
    if (!this.caps.authority.present) return refuse(t('authorityAbsent'));
    if (layer === 'session' && !this.sm.getSession(sessionId)) await this.sm.ensureSession(sessionId);
    const target = this.target(sessionId, at, layer);
    if (!('to' in target)) return refuse(target);
    if (itemText === undefined) return refuse(textLines([t('needItem'), this.editableLine(identity, target)]));
    const item = this.resolve(identity, target, itemText);
    if ('ok' in item) return item;
    const name = this.nameOf(item);
    // 空串是写出来的空值（聊天里的 `""`），照文字读法读
    if (valueText === undefined) return refuse(this.withChoices(t('needValue', { item: name }), item.field));
    const parsed = readText(item.field, valueText);
    const read = 'invalid' in parsed ? parsed : readFieldValue(item.field, parsed.value);
    if ('invalid' in read)
      return refuse(this.withChoices(t('invalidValue', { item: name, reason: read.invalid }), item.field));
    return this.write(identity, target, item, read.value ?? null);
  }

  /** 父会话改子会话设置的工具与 /session.set 写本会话层：同一份 */
  setAs(identity: UserIdentity, sessionId: string, item: string, text: string): Promise<Receipt> {
    return this.set(identity, sessionId, {}, 'session', item, text);
  }

  /**
   * 恢复继承：给了项只清那一项；不给项时清掉这一层里身份能改的全部项，只用于本会话与场所，平台类型档以上必须写明清哪一项
   */
  async reset(
    identity: Identity,
    sessionId: string,
    at: SessionAt,
    layer: SessionLayerName,
    itemText: string | undefined,
  ) {
    if (!this.caps.authority.present) return refuse(t('authorityAbsent'));
    const target = this.target(sessionId, at, layer);
    if (!('to' in target)) return refuse(target);
    if (itemText !== undefined) {
      const item = this.resolve(identity, target, itemText);
      return 'ok' in item ? item : this.write(identity, target, item, null);
    }
    const set = this.provider
      .rows(target.to)
      .filter(row => row.value !== undefined)
      .map(row => ({ plugin: row.plugin, key: row.key }));
    if (layer !== 'session' && layer !== 'place') {
      const items = set.map(item => this.nameOf(item));
      return refuse(
        textLines([
          t('resetNeedsItem', { layer: target.label }),
          ...(items.length > 0 ? [t('setHere', { items })] : []),
        ]),
      );
    }
    const clearable = this.editable(identity, target).filter(item =>
      set.some(own => own.plugin === item.plugin && own.key === item.key),
    );
    if (clearable.length === 0) return refuse(t('nothingToReset', { layer: target.label }));
    for (const item of clearable) {
      await this.provider.update(target.to, { plugin: item.plugin, key: item.key, value: null });
    }
    return {
      ok: true,
      text: t('resetDone', { layer: target.label, items: clearable.map(item => this.nameOf(item)), global: 'no' }),
    };
  }

  /** /session：只列身份在本会话层能改的项（owner 看到全部），每项写生效值与来源 */
  list(identity: Identity, sessionId: string, at: SessionAt): TextRef {
    if (!this.caps.authority.present) return t('authorityAbsent');
    const target = this.target(sessionId, at, 'session') as Target;
    const ctx = this.provider.contextOf(sessionId, at);
    const editable = this.editable(identity, target);
    const lines: Array<string | TextRef> = [];
    const session = this.sm.getSession(sessionId);
    lines.push(t('sessionHeader', { session: session ? sessionLabel(session) : sessionId }));
    for (const row of this.provider.rows({ sessionId, at })) {
      const item = editable.find(e => e.plugin === row.plugin && e.key === row.key);
      if (!item) continue;
      const params = { label: item.field.label, item: this.nameOf(item) };
      if (row.effective === undefined) {
        const unset = item.field.session.unset ?? t('unsetValue');
        const now = row.actual && (row.actual.label ?? writeText(item.field, row.actual.value));
        lines.push(t('rowUnset', { ...params, value: now ? t('unsetNow', { unset, now }) : unset }));
      } else {
        const value = writeText(item.field, row.effective);
        lines.push(t('row', { ...params, value, source: this.sourceText(row.source, ctx) }));
      }
    }
    if (!this.caps.authority.use.isOwner(identity.platform, identity.userId)) lines.push(t('onlyYours'));
    return textLines(lines);
  }

  /** 来源的称呼：作者默认写「默认」，其余同层的称呼 */
  private sourceText(source: SessionSource | undefined, ctx: SessionContext): string | TextRef {
    return source === undefined || source === 'default' ? t('sourceDefault') : this.layerText(source, ctx);
  }
}

/** 指令的发出者 */
const identityOf = (argv: CommandArgv): Identity => ({ platform: argv.session.platform, userId: argv.session.userId });
const layerOf = (argv: CommandArgv): SessionLayerName => (argv.options.at as SessionLayerName | undefined) ?? 'session';

/** 登记 /session 系列（指令服务缺席时登记留着，它上线后生效） */
export function registerCommands(caps: Caps, editor: SettingsEditor): void {
  const commands = caps.commands.use;
  const at = (argv: CommandArgv): SessionAt => ({ platform: argv.session.platform });

  commands
    .command('session', t('sessionDescription'), { risk: 'sensitive' })
    .action(argv => editor.list(identityOf(argv), argv.session.sessionId, at(argv)));

  commands
    .command('session.set [item:string] [value:text]', t('setDescription'), {
      risk: 'sensitive',
      examples: [
        '/session.set persona <name>',
        '/session.set --at place llm <instance>/<model>',
        '/session.set -n <name>',
      ],
    })
    .option('at', '--at <layer:string>', { description: t('atDescription'), choices: AT_LAYERS })
    .option('name', '-n <name:string>', { description: t('nameDescription') })
    .argument('item', t('itemArgument'))
    .argument('value', t('valueArgument'))
    .action(async (argv, item, value) => {
      const lines: TextRef[] = [];
      const name = typeof argv.options.name === 'string' ? argv.options.name.trim() : '';
      if (name) {
        await caps.sessionManager.use.ensureSession(argv.session.sessionId, { name });
        lines.push(t('renamed', { name }));
      }
      if (item !== undefined || !name) {
        const receipt = await editor.set(
          identityOf(argv),
          argv.session.sessionId,
          at(argv),
          layerOf(argv),
          item === undefined ? undefined : String(item),
          value === undefined ? undefined : String(value),
        );
        lines.push(receipt.text);
      }
      return textLines(lines);
    });

  commands
    .command('session.reset [item:string]', t('resetDescription'), {
      risk: 'sensitive',
      examples: ['/session.reset', '/session.reset persona', '/session.reset --at platformType persona'],
    })
    .option('at', '--at <layer:string>', { description: t('atDescription'), choices: AT_LAYERS })
    .argument('item', t('itemArgument'))
    .action(async (argv, item) => {
      const receipt = await editor.reset(
        identityOf(argv),
        argv.session.sessionId,
        at(argv),
        layerOf(argv),
        item === undefined ? undefined : String(item),
      );
      return receipt.text;
    });
}
