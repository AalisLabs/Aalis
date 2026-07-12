/**
 * plugin-sts2 —— 杀戮尖塔2 游戏身体
 *
 * 游戏作为 Aalis 的一个平台("身体")接入:
 *  - 感知: 轮询游戏内 SpireBridge mod 的 HTTP 桥(/state),需要决策时把局面
 *    作为 inbound:message 喂给 agent(经 gateway → agent.handleMessage);
 *  - 行动: agent 的回复回到本适配器 sendMessage,解析出 JSON 动作回写桥(/action);
 *  - 交流影响决策: 监听指定会话(如 QQ 群)的消息存为"建议";每次决策注入最近建议,
 *    群友一句"别贪精英"会真实改变它的选路;
 *  - 适时等待: 战斗回合即时决策;战略节点(选路/抓牌/商店/事件)先把处境播报到群,
 *    等待一个可配置窗口收集意见后再决策。
 *
 * 注意: 桥地址是 Parallels 虚拟机私网 IP,必须用裸 fetch(Node 原生 fetch 不读系统
 * 代理环境变量,天然直连);不能用 util-network-guard 的 safeFetch(会拦私网)。
 */

// biome-ignore lint/style/noRestrictedImports: 知识/建议文件是宿主机上仓库外的绝对路径(env 配置,与 sts2 桥同机),不在任何 storage 根内;走 storage gateway 反而要强制配 host:/ 直通根
import { existsSync, readFileSync, unwatchFile, watchFile } from 'node:fs';
import type { ConfigSchema, Context } from '@aalis/core';
import type {} from '@aalis/plugin-agent-api'; // agent:llm:before 钩子类型的模块增强
import type { MemoryService } from '@aalis/plugin-memory-api';
import type { IncomingMessage } from '@aalis/plugin-message-api';
import type { PlatformAdapter, PlatformConnection } from '@aalis/plugin-platform-api';
import { getPlatformAdapters } from '@aalis/plugin-platform-api';
import { useToolService } from '@aalis/plugin-tools-api';

export const name = '@aalis/plugin-sts2';
export const displayName = '杀戮尖塔2';
export const subsystem = 'platform';
export const provides = ['platform'];
export const inject = {
  required: ['tools'],
  optional: ['memory', 'agent', 'skills', 'embedding', 'vectorstore'],
};

export const configSchema: ConfigSchema = {
  bridge: {
    label: '游戏桥',
    fields: {
      bridgeUrl: { type: 'string', label: '桥地址', default: 'http://10.211.55.5:17171' },
      pollIntervalMs: { type: 'number', label: '轮询间隔(ms)', default: 2500 },
      autoStart: { type: 'boolean', label: '死亡后自动开新局', default: true },
    },
  },
  social: {
    label: '交流',
    fields: {
      adviceSessionIds: {
        type: 'textarea',
        label: '接收建议/播报的会话(每行一个 sessionId)',
        default: '',
      },
      adviceWindowMs: { type: 'number', label: '战略节点等待意见窗口(ms,0=不等)', default: 30000 },
      broadcast: { type: 'boolean', label: '播报处境与决策理由', default: true },
      debugAdviceFile: { type: 'string', label: '调试建议文件(监听追加内容作为建议)', default: '' },
    },
  },
  knowledge: {
    label: '知识',
    fields: {
      playbookFile: { type: 'string', label: '作战手册文件(注册为 skill)', default: '' },
      lessonsFile: { type: 'string', label: '教练手记文件(每次决策实时注入)', default: '' },
      knowledgeFile: { type: 'string', label: '敌人知识库文件(战斗按敌名注入)', default: '' },
    },
  },
};

// ---------- 类型 ----------

interface Sts2Config {
  bridgeUrl: string;
  pollIntervalMs: number;
  autoStart: boolean;
  adviceSessionIds: string[];
  adviceWindowMs: number;
  broadcast: boolean;
  /** 调试用:监听此文件,新增内容作为"建议"注入(无平台会话时的开发通道) */
  debugAdviceFile?: string;
  /** 作战手册(方法论,注册进 skill 系统);教练手记(经验,实时注入);敌人知识库(按敌名注入) */
  playbookFile?: string;
  lessonsFile?: string;
  knowledgeFile?: string;
}

interface Advice {
  text: string;
  from: string;
  ts: number;
}

interface HistoryEntry {
  screen: string;
  action: string;
  effect: 'changed' | 'none';
}

type GameState = Record<string, unknown>;

const SESSION_ID = 'sts2:main';

// 战略节点: 等意见 + 播报;其余(战斗等)即时决策
const STRATEGIC_SCREENS = new Set(['map', 'rewards', 'card_select', 'shop', 'event']);

// ---------- 配置收敛 ----------

function readConfig(raw: Record<string, unknown>): Sts2Config {
  const lines = String(raw.adviceSessionIds ?? '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
  // 配置同步会把插件块清洗回 schema 默认,env 兜底(逗号分隔)保证不丢
  for (const s of (process.env.STS2_ADVICE_SESSIONS || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)) {
    if (!lines.includes(s)) lines.push(s);
  }
  return {
    bridgeUrl: String(raw.bridgeUrl ?? 'http://10.211.55.5:17171').replace(/\/$/, ''),
    pollIntervalMs: Math.max(1000, Number(raw.pollIntervalMs ?? 2500)),
    autoStart: raw.autoStart !== false,
    adviceSessionIds: lines,
    adviceWindowMs: Math.max(0, Number(raw.adviceWindowMs ?? 30000)),
    broadcast: raw.broadcast !== false,
    debugAdviceFile: raw.debugAdviceFile ? String(raw.debugAdviceFile) : process.env.STS2_ADVICE_FILE || undefined,
    // 配置同步可能清掉 schema 外字段,知识路径一律带 env 兜底
    playbookFile: String(raw.playbookFile || '') || process.env.STS2_PLAYBOOK_FILE || undefined,
    lessonsFile: String(raw.lessonsFile || '') || process.env.STS2_LESSONS_FILE || undefined,
    knowledgeFile: String(raw.knowledgeFile || '') || process.env.STS2_KNOWLEDGE_FILE || undefined,
  };
}

// ---------- 工具 ----------

function digestOf(state: GameState): string {
  const json = JSON.stringify(state);
  let h = 0;
  for (let i = 0; i < json.length; i++) {
    h = (h * 31 + json.charCodeAt(i)) | 0;
  }
  return String(h);
}

function screenOf(state: GameState): string {
  if (state.in_combat) return 'combat';
  return String(state.screen ?? 'unknown');
}

/** 取回复文本中最后一个含 "action" 键的 JSON 对象 */
function parseAction(reply: string): Record<string, unknown> | undefined {
  const matches = reply.replace(/\n/g, ' ').match(/\{[^{}]*\}/g) ?? [];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(matches[i]) as Record<string, unknown>;
      if (typeof obj.action === 'string') return obj;
    } catch {
      /* keep scanning */
    }
  }
  return undefined;
}

function summarize(state: GameState): string {
  const scr = screenOf(state);
  if (scr === 'combat') {
    const p = (state.player ?? {}) as Record<string, unknown>;
    const enemies = (state.enemies ?? []) as Array<Record<string, unknown>>;
    const es = enemies
      .map(e => {
        const it = (e.intent ?? {}) as Record<string, unknown>;
        return `${e.name}(${e.hp}hp,${it.attack_damage ?? 0}x${it.hits ?? 0})`;
      })
      .join(',');
    return `战斗 r${state.round} 我${p.hp}/${p.max_hp}hp 格挡${p.block} 能量${p.energy} vs ${es}`;
  }
  const run = (state.run ?? {}) as Record<string, unknown>;
  if (scr === 'map') {
    const opts = ((state.options ?? []) as Array<Record<string, unknown>>).map(o => o.type).join('/');
    return `地图 第${state.floor}层 ${run.hp}/${run.max_hp}hp ${run.gold}金 可选:[${opts}]`;
  }
  return `${scr} (${run.hp ?? '?'}hp)`;
}

// ---------- 知识注入 ----------

function safeRead(file?: string): string {
  if (!file) return '';
  try {
    return existsSync(file) ? readFileSync(file, 'utf-8') : '';
  } catch {
    return '';
  }
}

/** 敌人知识库:按 "## 敌名" 切段 */
function kbSections(md: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const block of md.split(/^## /m).slice(1)) {
    const nl = block.indexOf('\n');
    if (nl < 0) continue;
    const name = block.slice(0, nl).trim();
    const body = block.slice(nl + 1).trim();
    if (name && body) out.push([name, body]);
  }
  return out;
}

function kbForEnemies(state: GameState, sections: Array<[string, string]>): string {
  const enemies = (state.enemies ?? []) as Array<Record<string, unknown>>;
  const names = enemies.map(e => String(e.name ?? ''));
  const hits: string[] = [];
  for (const [name, body] of sections) {
    if (names.some(n => n.includes(name) || name.includes(n))) hits.push(`## ${name}\n${body}`);
  }
  return hits.join('\n').slice(0, 1500);
}

/** 工具结果瘦身:每次 sts2_action 的返回都会留在上下文里被后续所有迭代重复计费,
 * 战斗只回精简视图(手牌/敌人/意图),非战斗剥掉 full_map 这类大块;
 * 完整数据在每次新决策的 requestDecision 里仍然全量携带。 */
function compactState(state: GameState): GameState {
  try {
    const powersOf = (o: Record<string, unknown>): string[] =>
      ((o.powers ?? []) as Array<Record<string, unknown>>).map(pw => `${pw.name}x${pw.amount}`);
    if (screenOf(state) === 'combat') {
      const p = (state.player ?? {}) as Record<string, unknown>;
      return {
        in_combat: true,
        round: state.round,
        player: {
          hp: p.hp,
          max_hp: p.max_hp,
          block: p.block,
          energy: p.energy,
          powers: powersOf(p),
          hand: ((p.hand ?? []) as Array<Record<string, unknown>>).map(c => ({
            index: c.index,
            title: c.title,
            cost: c.cost,
            desc: String(c.desc ?? '').slice(0, 80),
          })),
          draw_count: p.draw_count,
          discard_count: p.discard_count,
        },
        allies: state.allies,
        enemies: ((state.enemies ?? []) as Array<Record<string, unknown>>).map(e => ({
          name: e.name,
          hp: e.hp,
          block: e.block,
          intent: e.intent,
          powers: powersOf(e),
        })),
      };
    }
    const { full_map: _omit, ...rest } = state as Record<string, unknown>;
    return rest;
  } catch {
    return state;
  }
}

/** 确定性账房(与 python 驱动同源移植):LLM 不擅长口算,把账算好它只做选择 */
function combatMath(state: GameState): string {
  try {
    const p = (state.player ?? {}) as Record<string, unknown>;
    const hand = (p.hand ?? []) as Array<Record<string, unknown>>;
    const energy = Number(p.energy ?? 0);
    const enemies = (state.enemies ?? []) as Array<Record<string, unknown>>;

    const dmgOf = (c: Record<string, unknown>): number => {
      let total = 0;
      for (const m of String(c.desc ?? '').matchAll(/造成(\d+)点伤害(?:[^\d]*?(\d+)次)?/g)) {
        total += Number(m[1]) * (m[2] ? Number(m[2]) : 1);
      }
      return total;
    };
    const blkOf = (c: Record<string, unknown>): number => {
      let total = 0;
      for (const m of String(c.desc ?? '').matchAll(/获得(\d+)点.*?格挡/g)) total += Number(m[1]);
      return total;
    };

    type Item = [number, number, unknown];
    const byValue = (items: Item[]): Item[] =>
      items.sort((a, b) => b[0] / Math.max(b[1], 0.5) - a[0] / Math.max(a[1], 0.5));
    const atk = byValue(hand.filter(c => dmgOf(c) > 0).map(c => [dmgOf(c), Number(c.cost ?? 0), c.index] as Item));
    const blk = byValue(hand.filter(c => blkOf(c) > 0).map(c => [blkOf(c), Number(c.cost ?? 0), c.index] as Item));

    const greedy = (items: Item[]): [number, unknown[]] => {
      let e = energy,
        total = 0;
      const used: unknown[] = [];
      for (const [v, cost, idx] of items) {
        if (cost <= e) {
          e -= cost;
          total += v;
          used.push(idx);
        }
      }
      return [total, used];
    };
    const [maxDmg, dmgCards] = greedy(atk);
    const [maxBlk, blkCards] = greedy(blk);
    const incoming = enemies.reduce((sum, e) => {
      const it = (e.intent ?? {}) as Record<string, unknown>;
      return sum + Number(it.attack_damage ?? 0) * Math.max(Number(it.hits ?? 1), 1);
    }, 0);

    const lines = [
      `敌方来袭总伤=${incoming};全力输出可打${maxDmg}(用牌index${JSON.stringify(dmgCards)});全力格挡可得${maxBlk}(用牌index${JSON.stringify(blkCards)})`,
    ];
    for (const e of enemies) {
      const ehp = Number(e.hp ?? 0) + Number(e.block ?? 0);
      const vuln = ((e.powers ?? []) as Array<Record<string, unknown>>).some(pw =>
        String(pw.name ?? '').includes('易伤'),
      );
      const eff = vuln ? Math.floor(maxDmg * 1.5) : maxDmg;
      lines.push(`${e.name}(有效血${ehp}${vuln ? ',易伤×1.5' : ''}):${eff >= ehp ? '可斩杀!' : `差${ehp - eff}`}`);
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

/** skills 服务的最小结构化接口(避免对 plugin-skills 的硬依赖) */
interface SkillsServiceLite {
  getSkill(name: string): unknown;
  createSkill(input: Record<string, unknown>): Promise<unknown>;
  updateSkill(name: string, patch: Record<string, unknown>): Promise<unknown>;
}
interface EmbedderLite {
  embed(text: string): Promise<number[]>;
}
interface VectorStoreLite {
  add(vec: number[], metadata: Record<string, unknown>): Promise<unknown>;
  save?(): Promise<void>;
  deleteByFilter?(filter: Record<string, unknown>): Promise<unknown>;
}

// ---------- 主体 ----------

export function apply(ctx: Context, rawConfig: Record<string, unknown>): void {
  const cfg = readConfig(rawConfig);
  const logger = ctx.logger.child('sts2');

  // --- 运行时状态 ---
  const advices: Advice[] = [];
  const history: HistoryEntry[] = [];
  let busy = false; // 已把局面交给 agent,等它回复
  let busySince = 0;
  let lastDigest = '';
  let lastActionDigest = ''; // 上次动作执行时的局面摘要,用于 effect 判定
  let pendingAction: string | undefined;
  let stuckCount = 0;
  let adviceWaitUntil = 0; // 战略节点的意见收集截止时间
  let waitingScreenDigest = '';
  let lastRequestAt = 0; // 上次向 agent 发起决策的时间(重发保护)
  let pausedUntil = 0; // 观众喊"暂停"后的决策冻结截止(短憩,最长10分钟)
  let playingEnabled = true; // 观众喊"停止爬塔/开始爬塔"的总开关(长期,直到反向指令)
  let nowPlaying = ''; // 最近局面摘要(供其它会话感知"我在爬塔")
  let nowPlayingAt = 0;
  let lastCommentAt = 0; // 点评播报限频(里程碑豁免),别刷屏群聊

  // --- 桥 I/O(裸 fetch:私网直连,不走系统代理,勿用 safeFetch) ---
  async function bridge(path: string): Promise<string> {
    const resp = await fetch(`${cfg.bridgeUrl}${path}`, { signal: AbortSignal.timeout(10000) });
    return await resp.text();
  }

  async function getState(): Promise<GameState | undefined> {
    try {
      return JSON.parse(await bridge('/state')) as GameState;
    } catch (e) {
      logger.warn(`读取游戏状态失败: ${String(e)}`);
      return undefined;
    }
  }

  async function doAction(action: Record<string, unknown>): Promise<string> {
    const type = String(action.action);
    const params = Object.entries(action)
      .filter(([k, v]) => k !== 'action' && v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');
    return await bridge(`/action?type=${encodeURIComponent(type)}${params ? `&${params}` : ''}`);
  }

  // --- 播报到建议会话(QQ 群等) ---
  async function broadcast(text: string): Promise<void> {
    if (!cfg.broadcast || cfg.adviceSessionIds.length === 0) return;
    for (const sid of cfg.adviceSessionIds) {
      try {
        for (const adapter of getPlatformAdapters(ctx)) {
          const can = adapter.canHandle ? await adapter.canHandle(sid) : sid.startsWith(`${adapter.platform}:`);
          if (can) {
            await adapter.sendMessage(sid, text);
            break;
          }
        }
      } catch (e) {
        logger.warn(`播报到 ${sid} 失败: ${String(e)}`);
      }
    }
  }

  // --- 建议收集:监听指定会话的人类消息 → belief;支持"暂停/继续"控场指令 ---
  function pushAdvice(rawText: string, from: string): void {
    const t = rawText.trim();
    if (!t) return;
    if (/^(停止|别爬了|收工|下班|不玩了|stop)/i.test(t)) {
      playingEnabled = false;
      pausedUntil = 0;
      logger.info(`<${from}> 喊了停止爬塔——总开关关闭(说"开始爬塔"重新开工)`);
      void broadcast('🗼 好,收工不爬了。想让我继续就喊"开始爬塔"。');
      return;
    }
    if (/^(开始爬|开爬|去爬塔|开工|start)/i.test(t)) {
      playingEnabled = true;
      pausedUntil = 0;
      adviceWaitUntil = 0;
      logger.info(`<${from}> 喊了开始爬塔——总开关打开`);
      void broadcast('🗼 开工!爬塔去了。');
      return;
    }
    if (/^(暂停|等等|等一下|先别|hold on|wait)/i.test(t)) {
      pausedUntil = Date.now() + 10 * 60 * 1000;
      logger.info(`<${from}> 喊了暂停,冻结决策(说"继续"解除)`);
      void broadcast('🗼 好,我先停手等你们商量,想好了喊"继续"。');
      return;
    }
    if (/^(继续|开打|打吧|resume|go)/i.test(t)) {
      pausedUntil = 0;
      adviceWaitUntil = 0;
      logger.info(`<${from}> 喊了继续,恢复决策`);
      void broadcast('🗼 收到,继续!');
      return;
    }
    const advice: Advice = { text: t.slice(0, 200), from, ts: Date.now() };
    advices.push(advice);
    if (advices.length > 10) advices.shift();
    logger.info(`收到建议 <${advice.from}>: ${advice.text}`);
    const mem = ctx.getService('memory') as MemoryService | undefined;
    void mem?.saveMetadata?.('sts2-beliefs', `b:${advice.ts}`, { ...advice });
    // 建议已到 → 提前收窗,下个 tick 就带着它决策(不必傻等满整个窗口)
    if (adviceWaitUntil > Date.now()) adviceWaitUntil = Date.now();
  }

  ctx.on('inbound:message', (msg: IncomingMessage) => {
    if (!cfg.adviceSessionIds.includes(msg.sessionId)) return;
    if (msg.source === 'sts2') return; // 自己的播报不算建议
    pushAdvice(msg.content, msg.nickname || msg.userId || 'unknown');
  });

  // --- 跨会话在场感:其它会话(QQ 私聊/群聊)的对话里注入"我正在爬塔"状态一行 ---
  ctx.middleware('agent:llm:before', async (data, next) => {
    const fresh = nowPlaying && Date.now() - nowPlayingAt < 5 * 60 * 1000;
    if (fresh && data.sessionId && !String(data.sessionId).startsWith('sts2:')) {
      const has = data.messages.some(m => m.role === 'system' && m.metadata?.injector === 'sts2-presence');
      if (!has) {
        const idx = data.messages.findIndex(m => m.role !== 'system');
        data.messages.splice(idx === -1 ? data.messages.length : idx, 0, {
          role: 'system',
          content:
            `(状态同步:我此刻正在玩杀戮尖塔2——${nowPlaying}。` +
            '如果对方在聊我的对局或给建议,自然接话;他们的建议会真实影响我接下来的选路/抓牌/打法。' +
            '控场口令(在建议会话里说):"暂停"=停手商量,"继续"=恢复,"停止爬塔"=收工,"开始爬塔"=开工。)',
          metadata: { injector: 'sts2-presence' },
        });
      }
    }
    await next();
  });

  // --- 调试建议通道:文件尾行变化 → 注入建议(开发期无群聊会话时用) ---
  if (cfg.debugAdviceFile) {
    const f = cfg.debugAdviceFile;
    let lastText = existsSync(f) ? readFileSync(f, 'utf-8') : '';
    watchFile(f, { interval: 2000 }, () => {
      try {
        const now = readFileSync(f, 'utf-8');
        const added = now.slice(lastText.length).trim();
        lastText = now;
        if (!added) return;
        for (const line of added
          .split('\n')
          .map(s => s.trim())
          .filter(Boolean)) {
          pushAdvice(line, '调试通道');
        }
      } catch {
        /* 文件可能暂不可读 */
      }
    });
    ctx.onDispose(() => unwatchFile(f));
  }

  // --- 知识接线:手册→skill(方法论);知识库/手记→memory(经验);向量层在场则补语义索引 ---
  let manualViaSkill = false;
  ctx.on('ready', () => {
    void (async () => {
      const playbook = safeRead(cfg.playbookFile);
      const skills = ctx.getService('skills') as SkillsServiceLite | undefined;
      if (skills && playbook) {
        try {
          const meta = {
            description:
              '杀戮尖塔2 铁甲战士作战手册:决策基准/构筑流派/地图路线/战斗数学/逐Boss对策/诅咒状态牌图鉴。' +
              '进行杀戮尖塔2 对局决策时必读。',
            triggers: ['杀戮尖塔'],
            body: playbook,
          };
          if (skills.getSkill('sts2-combat-manual')) await skills.updateSkill('sts2-combat-manual', meta);
          else await skills.createSkill({ name: 'sts2-combat-manual', ...meta });
          manualViaSkill = true;
          logger.info('作战手册已注册为 skill: sts2-combat-manual(决策消息自动触发)');
        } catch (e) {
          logger.warn(`注册作战手册 skill 失败,回退为内联注入: ${String(e)}`);
        }
      }

      const mem = ctx.getService('memory') as MemoryService | undefined;
      const kb = kbSections(safeRead(cfg.knowledgeFile));
      for (const [enemy, text] of kb) void mem?.saveMetadata?.('sts2-kb', enemy, { text, ts: Date.now() });
      const lessons = safeRead(cfg.lessonsFile);
      if (lessons) void mem?.saveMetadata?.('sts2-coach', 'lessons', { text: lessons, ts: Date.now() });
      if (kb.length || lessons)
        logger.info(
          `知识入库: 敌人条目${kb.length}个 + 教练手记${lessons ? '1' : '0'}份(namespace sts2-kb/sts2-coach)`,
        );

      // 语义索引:embedding+vectorstore 都在场才做;幂等(先清 kb:sts2 旧条目)
      const embedder = ctx.getService('embedding') as EmbedderLite | undefined;
      const store = ctx.getService('vectorstore') as VectorStoreLite | undefined;
      if (embedder && store && kb.length) {
        try {
          await store.deleteByFilter?.({ sessionId: 'kb:sts2' });
          for (const [enemy, text] of kb) {
            const content = `【${enemy}】${text}`.slice(0, 400);
            const vec = await embedder.embed(content);
            await store.add(vec, {
              sessionId: 'kb:sts2',
              platform: 'kb',
              userId: 'kb',
              nickname: '尖塔知识库',
              content,
              timestamp: Date.now(),
              kbType: 'enemy',
            });
          }
          await store.save?.();
          logger.info(`知识库语义索引完成: ${kb.length} 条`);
        } catch (e) {
          logger.warn(`知识库语义索引失败(不影响决策注入): ${String(e)}`);
        }
      }
    })();
  });

  // --- 决策请求:把局面(+手册/手记/知识/账房+建议+历史)喂给 agent ---
  async function requestDecision(state: GameState, digest: string, warn: string): Promise<void> {
    const recentAdvices = advices
      .filter(a => Date.now() - a.ts < 30 * 60 * 1000)
      .map(a => `- ${a.from}: ${a.text}`)
      .join('\n');
    const hist = history.map(h => `${h.screen} -> ${h.action} (${h.effect})`).join('\n');

    // 知识注入:手记实时重读(教练随时可改);敌人知识/账房仅战斗时;手册优先走 skill,失败才内联
    const lessonsText = safeRead(cfg.lessonsFile).slice(0, 3500);
    const playbookInline = manualViaSkill ? '' : safeRead(cfg.playbookFile).slice(0, 7000);
    const inCombat = screenOf(state) === 'combat';
    const kbText = inCombat ? kbForEnemies(state, kbSections(safeRead(cfg.knowledgeFile))) : '';
    const mathText = inCombat ? combatMath(state) : '';

    const content = [
      '【杀戮尖塔2·轮到你决策】你正在亲自玩杀戮尖塔2,以下是当前局面的完整数据。',
      '【快速应对表】(常规局面照做,禁止长篇推理;仅 boss/精英/血线<40%/定流派抉择才值得多想)',
      '- 敌方全体意图伤害=0 → 全力输出/铺场,不留格挡',
      '- 账房给出"可斩杀" → 按账房牌序直接执行;能量0且无0费牌 → 直接 end_turn',
      '- 手牌只剩一张可打 → 直接打出(有残血敌先斩杀)',
      '- 奖励只剩金币/药水 → 拿走后 proceed(药水槽满跳过药水);不契合构筑的卡直接跳过,卡组越薄越强',
      '- 商店金<50 → leave_shop;删牌服务通常是最高价值购买;篝火 HP≥65% → 升级,<45% → 休息',
      '- screen=card_choice(游戏暂停等你选牌) → 用 {"action":"pick_cards","indexes":"0"} 应答(多选逗号;min=0 可空串跳过)',
      '- 药水是免费动作别攥着;地图用 full_map 倒推路线;未知界面点 controls 里的按钮',
      '工具一次调用一个动作,看到返回的新局面再决定下一个。',
      '',
      playbookInline ? `【作战手册】\n${playbookInline}\n` : '',
      lessonsText ? `【教练手记(旁观你几十局的教练写的,优先级高于一般直觉)】\n${lessonsText}\n` : '',
      kbText ? `【你对这些敌人的实战知识】\n${kbText}\n` : '',
      mathText ? `【账房(确定性计算,数值可信)】\n${mathText}\n` : '',
      recentAdvices ? `【观众/群友的建议(参考,你自己拿主意)】\n${recentAdvices}\n` : '',
      hist ? `【你最近的操作】\n${hist}\n` : '',
      warn ? `【警告】${warn}\n` : '',
      `【当前局面】\n${JSON.stringify(state)}`,
      '',
      '请用 sts2_action 工具执行操作——战斗回合里连续调用直到打完(出牌→看返回的新局面→再出→end_turn),',
      '非战斗界面执行相应的选择/前进动作。常规操作直接调工具,推理压到三句内。',
      '全部做完后点评一两句(会播报给观众);若上面有观众建议,点评第一句先回应建议(采纳与否+一句理由)。',
    ]
      .filter(Boolean)
      .join('\n');

    busy = true;
    busySince = Date.now();
    lastRequestAt = Date.now();
    lastActionDigest = digest;
    const message: IncomingMessage = {
      content,
      sessionId: SESSION_ID,
      platform: 'sts2',
      source: 'sts2',
      actor: { platform: 'webui', userId: 'console' },
    };
    await ctx.emit('inbound:message', message);
  }

  // --- 游戏操作工具:persona 输出格式会吞掉自由文本里的 JSON,动作必须走工具调用。
  //     好处:一次决策可以连续调用多次(出多张牌→看结果→再出),真正的"打完这回合"。 ---
  const tools = useToolService(ctx);
  tools.registerGroup({
    name: 'sts2',
    label: '杀戮尖塔2',
    description: '操作杀戮尖塔2 的对局(出牌/选路/购物/用药水等)',
  });
  tools.register({
    groups: ['sts2'],
    definition: {
      type: 'function',
      function: {
        name: 'sts2_action',
        description:
          '在杀戮尖塔2 中执行一个操作,返回执行结果和最新局面。战斗中可连续调用(出一张牌→看局面→再出),' +
          '直到能量用完或没有值得做的,再用 end_turn 结束回合。' +
          '动作: play_card(index,target)/end_turn/use_potion(index,target)/choose_node(index)/' +
          'choose_event(index)/choose_card(index)/take_reward(index)/proceed/buy(index)/leave_shop/' +
          'click(id或name)/start_run/continue_run',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', description: '动作类型' },
            index: { type: 'number', description: '牌/选项/奖励/药水槽位的索引' },
            target: { type: 'number', description: '敌人索引(指向性的牌或药水)' },
            id: { type: 'number', description: 'click:控件 id' },
            name: { type: 'string', description: 'click:控件名(如 SelectModeConfirmButton)' },
          },
          required: ['action'],
        },
      },
    },
    handler: async args => {
      try {
        if (!playingEnabled) {
          return JSON.stringify({
            error: '观众喊了"停止爬塔",立刻停手,不要再执行任何游戏操作;等他们喊"开始爬塔"再玩。',
          });
        }
        if (Date.now() < pausedUntil) {
          return JSON.stringify({
            error: '观众喊了"暂停",立刻停手,不要再执行任何游戏操作;说说你此刻的想法,等观众喊"继续"再打。',
          });
        }
        busySince = Date.now(); // 还在连续行动 = agent 活着,别把长回合误判成失联
        const res = await doAction(args);
        await new Promise(r => setTimeout(r, 1800)); // 等动画落定再读局面
        const state = await getState();
        if (state) {
          lastDigest = digestOf(state);
          stuckCount = 0;
        }
        return JSON.stringify({ result: JSON.parse(res || '{}'), state: state ? compactState(state) : 'unreadable' });
      } catch (e) {
        return JSON.stringify({ error: String(e) });
      }
    },
  });

  // --- 平台适配器:agent 的回复从这里回来 ---
  const adapter: PlatformAdapter = {
    adapterName: '杀戮尖塔2',
    platform: 'sts2',
    sessionTypes: ['private'],
    getConnections: (): PlatformConnection[] => [{ id: 'sts2', platform: 'sts2', status: 'online' }],
    canHandle: sid => sid.startsWith('sts2:'),
    isReady: () => true,
    async sendMessage(_sid: string, content: string): Promise<void> {
      // 动作都通过 sts2_action 工具执行了;这里收到的是 persona 的最终点评。
      busy = false;
      const action = parseAction(content); // 兜底:万一它把动作写在了消息里
      if (action) {
        pendingAction = JSON.stringify(action);
        try {
          const res = await doAction(action);
          logger.info(`执行(消息内动作) ${pendingAction} => ${res.slice(0, 100)}`);
        } catch (e) {
          logger.warn(`动作执行失败: ${String(e)}`);
        }
      }
      const commentary = content.replace(/\{[^{}]*\}\s*$/, '').trim();
      if (commentary) {
        logger.info(`💬 ${commentary.slice(0, 150)}`);
        // 人体工学:普通点评 ≥45s 一条防刷屏;boss/生死/通关等里程碑即刻播
        const milestone = /boss|Boss|死|阵亡|通关|胜|翻车|精英/.test(commentary);
        if (cfg.broadcast && (milestone || Date.now() - lastCommentAt > 45000)) {
          lastCommentAt = Date.now();
          void broadcast(`🗼 ${commentary.slice(0, 150)}`);
        }
      }
    },
  };
  ctx.provide('platform', adapter);

  // --- 主轮询循环 ---
  let lastMilestone = '';
  const timer = setInterval(() => {
    void (async () => {
      // agent 决策超时保护
      if (busy && Date.now() - busySince > 120000) {
        logger.warn('agent 决策超时,放弃本次等待');
        busy = false;
      }
      if (busy) return;
      if (!playingEnabled) return; // 观众喊了停止爬塔(总开关)
      if (Date.now() < pausedUntil) return; // 观众喊了暂停(短憩)

      const state = await getState();
      if (!state) return;
      const scr = screenOf(state);
      const digest = digestOf(state);
      nowPlaying = summarize(state);
      nowPlayingAt = Date.now();

      // effect 判定 + 历史记录
      if (pendingAction) {
        const effect: HistoryEntry['effect'] = digest !== lastActionDigest ? 'changed' : 'none';
        history.push({ screen: scr, action: pendingAction, effect });
        if (history.length > 6) history.shift();
        stuckCount = effect === 'none' ? stuckCount + 1 : 0;
        pendingAction = undefined;
      }

      // 主菜单:机械处理,不劳烦 agent
      if (scr === 'other' && state.scope === 'root') {
        const controls = (state.controls ?? []) as Array<Record<string, unknown>>;
        const names = controls.map(c => String(c.name ?? ''));
        if (names.includes('AbandonRunButton') && !names.includes('ContinueButton')) return; // 菜单还在加载
        if (names.includes('ContinueButton') && names.some(n => n.includes('MainMenu') === false)) {
          // 主菜单有存档 → 续
          if (names.includes('AbandonRunButton')) {
            await doAction({ action: 'continue_run' });
            return;
          }
        }
        if (names.includes('SingleplayerButton')) {
          if (!cfg.autoStart) return;
          await doAction({ action: 'start_run' });
          void broadcast('🗼 新的一局爬塔开始了!');
          return;
        }
      }

      // 常见免脑局面:机械处理,一次 LLM 都不花(成本优化的第0层)
      if (scr === 'map') {
        const opts = (state.options ?? []) as Array<Record<string, unknown>>;
        if (opts.length === 1) {
          await doAction({ action: 'choose_node', index: 0 });
          return;
        }
      }
      if (scr === 'event') {
        const opts = (state.options ?? []) as Array<Record<string, unknown>>;
        if (opts.length === 1 && opts[0]?.is_proceed) {
          await doAction({ action: 'choose_event', index: 0 });
          return;
        }
      }
      if (scr === 'other' && String(state.overlay ?? '').includes('GameOver')) {
        const controls = (state.controls ?? []) as Array<Record<string, unknown>>;
        const cont = controls.find(c => String(c.name ?? '').includes('Continue')) ?? controls[0];
        if (cont) await doAction({ action: 'click', id: cont.id });
        return;
      }

      // 战斗中手牌为空 = 抽牌/敌方回合动画,等下一轮
      if (scr === 'combat') {
        const hand = ((state.player ?? {}) as Record<string, unknown>).hand as unknown[] | undefined;
        if (!hand || hand.length === 0) return;
      }

      // 局面没变 → 若距上次请求不久则等待(动画/回复在路上);太久没动静就重发,
      // 否则 agent 一次失联会让整个循环永久停摆。
      if (digest === lastDigest && stuckCount === 0 && Date.now() - lastRequestAt < 45000) return;
      lastDigest = digest;

      // 战略节点:播报处境,开一个意见收集窗口(有群聊会话或调试建议文件任一即启用;
      // 建议一到就提前收窗,不会傻等)
      if (
        STRATEGIC_SCREENS.has(scr) &&
        cfg.adviceWindowMs > 0 &&
        (cfg.adviceSessionIds.length > 0 || cfg.debugAdviceFile)
      ) {
        if (waitingScreenDigest !== digest) {
          waitingScreenDigest = digest;
          adviceWaitUntil = Date.now() + cfg.adviceWindowMs;
          const brief = summarize(state);
          if (brief !== lastMilestone) {
            lastMilestone = brief;
            void broadcast(`🗼 ${brief}\n(${Math.round(cfg.adviceWindowMs / 1000)}秒内可以给我建议)`);
          }
          return;
        }
        if (Date.now() < adviceWaitUntil) return; // 窗口未关,继续收集意见
      }

      const warn =
        stuckCount >= 3
          ? `局面已连续 ${stuckCount} 次未因你的动作而变化,换一种动作(可用 click 点 controls 里的按钮)。`
          : '';
      if (stuckCount >= 10) {
        logger.error(`卡死:${summarize(state)}——暂停自动决策,等待人工`);
        void broadcast(`🗼 我卡住了:${summarize(state)},谁来救救`);
        stuckCount = 0;
        return;
      }
      await requestDecision(state, digest, warn);
    })();
  }, cfg.pollIntervalMs);
  ctx.onDispose(() => clearInterval(timer));

  logger.info(
    `杀戮尖塔2 身体已接入: 桥=${cfg.bridgeUrl} 轮询=${cfg.pollIntervalMs}ms ` +
      `建议会话=${cfg.adviceSessionIds.length}个 等待窗口=${cfg.adviceWindowMs}ms`,
  );
}
