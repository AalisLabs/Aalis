// ============================================================
// @aalis/plugin-media — 多模态媒体识别调度器
//
// 职责：
//   1. 注册 'media' 服务（MediaService），调度 vision/audio/video 处理
//   2. 内置 LLM-as-Processor adapter：自动把所有 vision/audio LLM 包装为 MediaProcessor
//   3. 注册 agent preprocessor，归一化 IncomingMessage.attachments 并写描述
//   4. 视频处理编排：ffmpeg 抽帧 + ASR 抽音轨 → 拼综合描述
//
// 与 plugin-image-recognition 的关系：
//   - plugin-image-recognition 已被本插件取代并删除
//   - 所有图片/动图/视频/音频路径统一走 attachments[]
// ============================================================

import { agent } from '@aalis/api-agent';
import { asr } from '@aalis/api-asr';
import { hooks } from '@aalis/api-hooks';
import { llm } from '@aalis/api-llm';
import { media } from '@aalis/api-media';
import { memory } from '@aalis/api-memory';
import { createProcessGateway, processService } from '@aalis/api-process';
import { sessionManager } from '@aalis/api-session-manager';
import { createStorageGateway, storage as storageService } from '@aalis/api-storage';
import { tools } from '@aalis/api-tools';
import { type BoundOf, config, definePlugin, events, lifecycle, logger, optional, provide } from '@aalis/core';
import { type ConfigOf, defineConfig, parseConfig, type SchemaField } from '@aalis/schema-config';
import {
  clearDescriptionCache,
  DESCRIPTION_KINDS,
  type DescriptionKind,
  flushDescriptionCache,
  loadDescriptionCache,
} from './cache.js';
import { DEFAULT_AUDIO_PROMPT, DEFAULT_VISION_BATCH_PROMPT, DEFAULT_VISION_PROMPT } from './llm-adapter.js';
import { buildPreprocessor } from './preprocessor.js';
import { setMediaRuntime } from './runtime.js';
import { type MediaConfigResolved, MediaServiceImpl } from './service.js';
import { registerMediaTools } from './tools.js';

const name = '@aalis/plugin-media';

/** /clear 回执里描述缓存类型的称呼 */
const DESCRIPTION_KIND_LABELS: Record<DescriptionKind, string> = { image: '图片', video: '视频' };

const configSchema = defineConfig({
  vision: {
    label: '图像识别',
    fields: {
      prefer: {
        type: 'llm-ref',
        label: '识别模型',
        description: '把图片转成文字描述的模型。留空则自动选择优先级最高的 vision LLM。',
      },
      recognizeOnArrival: {
        type: 'boolean',
        label: '接触到图片立即识别',
        default: true,
        description:
          '开启：图片到达即识别，描述进档案与向量库（可被召回），未触发回复的消息也留下记忆。' +
          '关闭：档案只留图片指针，主模型需要时再经 analyze_image 按需查看；此时图片内容不可被检索召回。',
      },
      delivery: {
        type: 'select',
        label: '主模型看图方式',
        options: [
          { label: '自动：主模型有 vision 能力则直通原图，否则交给识别模型转文字', value: 'auto' },
          { label: '直通：原图交给主模型（动图抽帧为多张静图；需主模型 vision 能力）', value: 'passthrough' },
          { label: '转文字：始终由识别模型描述，主模型只读文字', value: 'describe' },
        ],
        default: 'auto',
        description: '决定当轮附件与 analyze_image 的交付形态。',
      },
      maxTokens: { type: 'number', label: '描述最大 token', default: 300 },
      think: {
        type: 'boolean',
        label: '启用思考链 (thinking)',
        default: false,
        description: '启用后识别质量可能提升但 token 成本上升；关闭且后端为 Ollama 时会传 reasoning_effort=none。',
      },
      prompt: {
        type: 'textarea',
        label: '单图描述 prompt',
        default: '',
        description:
          '填写后完全覆盖 auto 档（自路由）与 casual 档的描述 prompt；' +
          'detailed/professional 档仍用各自内置模板。留空时 auto 档用内置自路由 prompt' +
          '（模型看图自判类型给相应详略），casual 档用内置简洁模板。\n' +
          `内置简洁模板供参考：${DEFAULT_VISION_PROMPT}`,
      },
      batchPrompt: {
        type: 'textarea',
        label: '多图批量描述 prompt',
        default: '',
        description: `多张图片一起描述时使用（动图抽帧 / 图组）。留空则回落到“单图 prompt”或内置默认。\n默认：${DEFAULT_VISION_BATCH_PROMPT}`,
      },
    },
  },
  audio: {
    label: '音频识别（转写 + 描述）',
    fields: {
      mode: {
        type: 'select',
        label: '模式',
        options: [
          { label: '启用（转写后注入上下文）', value: 'enabled' },
          { label: '直通：原始音频交给主模型（需主模型有 audio 能力）', value: 'passthrough' },
          { label: '禁用', value: 'disabled' },
        ],
        default: 'enabled',
      },
      prefer: {
        type: 'select',
        label: '处理后端',
        // options 在运行时由 media 据已注册的 Whisper/ASR 与音频 LLM 动态补全（见 index.ts refreshAudioPrefer）；
        // 静态列表不全，allowCustom 让校验与解析不按它查取值范围。
        options: [{ label: '自动（按优先级）', value: '' }] as Array<{ label: string; value: string }>,
        allowCustom: true,
        default: '',
        description: 'Whisper/ASR 与「能识别音频的 LLM」合在一个下拉里选；留空=按优先级自动。可选项随已装后端变化。',
      },
      language: {
        type: 'string',
        label: '默认语种 (ISO 639-1)',
        default: '',
        description: '仅对 Whisper 类 ASR 生效；LLM-as-audio 会在 prompt 里作为提示。',
      },
      maxTokens: {
        type: 'number',
        label: '最大输出 token',
        default: 1024,
        description: 'LLM-as-audio 专用。e4b 等小模型在 thinking enabled 下需 ≥1024，否则空响应。',
      },
      think: {
        type: 'boolean',
        label: '启用思考链 (thinking)',
        default: true,
        description:
          'LLM-as-audio 专用。启用后识别质量更高但 token 成本 ×5-8；关闭则会传 reasoning_effort=none 给 Ollama。',
      },
      prompt: {
        type: 'textarea',
        label: '自定义 prompt',
        default: '',
        description: `LLM-as-audio 专用。留空使用内置全能描述 prompt。\n默认：${DEFAULT_AUDIO_PROMPT}`,
      },
    },
  },
  video: {
    label: '视频识别',
    fields: {
      mode: {
        type: 'select',
        label: '模式',
        options: [
          { label: '关键帧 + 音轨转写', value: 'frames+asr' },
          { label: '仅关键帧', value: 'frames-only' },
          { label: '禁用', value: 'disabled' },
        ],
        default: 'frames+asr',
      },
      maxFrames: { type: 'number', label: '最大关键帧数', default: 5 },
      framesHint: {
        type: 'textarea',
        label: '抽帧描述 hint',
        default: '',
        description: '抽帧后拼帧下发 vision 模型时的 hint。留空使用默认：“以下为同一视频的关键帧，按时间顺序排列。”',
      },
      animatedPrompt: {
        type: 'textarea',
        label: '动图/短视频描述 prompt',
        default: '',
        description: '`describeImage` 遇到动图时的整段描述 prompt（替换内置多图批量模板）；留空使用内置多图批量模板。',
      },
      framePrefix: {
        type: 'string',
        label: '画面描述前缀',
        default: '[画面] ',
        description: '拼到抽帧综合描述前的标记，例如 “[画面] …”。',
      },
      audioTrackPrefix: {
        type: 'string',
        label: '音轨转写前缀',
        default: '[音轨] ',
        description: '拼到视频音轨转写前的标记，例如 “[音轨] …”。',
      },
    },
  },
  animatedImage: {
    label: '动图 / GIF',
    fields: {
      maxFrames: {
        type: 'number',
        label: '最大关键帧数',
        default: 5,
        description:
          '动图（gif/webp 动画等）抽帧上限，与视频 video.maxFrames 独立。动图信息量较低，默认 5 已足够；调高会增加 vision 调用成本。',
      },
    },
  },
  contextHistory: {
    label: '多模态上下文注入',
    fields: {
      enabled: {
        type: 'boolean',
        label: '允许多模态 processor 读取聊天上下文',
        default: true,
        description:
          '启用后，图片描述 / 音频识别 / 视频抽帧调用多模态模型时，会将近期聊天记录拼到 prompt 里，让模型能联系上下文进行识别。对传统 Whisper-style ASR 后端无效。',
      },
      maxMessages: {
        type: 'number',
        label: '上下文最大消息条数',
        default: 4,
      },
    },
  },
  senderContext: {
    label: '发送者画像注入 (vision)',
    fields: {
      enabled: {
        type: 'boolean',
        label: '允许在 vision 上下文中注入发送者 user-profile 摘要',
        default: true,
        description:
          '启用后，vision 描述图片时会带上发送者的长期 fact 摘要（来自 plugin-user-profile），帮助模型理解 “草羊机截图 = Minecraft 玩家在炫耀” 类场景。读取失败微 user-profile 未启用时静默跳过，不会阻断识别。',
      },
      profileMaxChars: {
        type: 'number',
        label: 'profile 摘要最大字符数',
        default: 200,
        description: '超过截断。填 0 等于禁用 profile 注入。',
      },
    },
  },
});

function resolveCfg(cfg: ConfigOf<typeof configSchema>): MediaConfigResolved {
  return {
    vision: {
      recognizeOnArrival: cfg.vision.recognizeOnArrival,
      delivery: cfg.vision.delivery,
      prefer: cfg.vision.prefer || undefined,
      maxTokens: cfg.vision.maxTokens,
      think: cfg.vision.think,
      prompt: cfg.vision.prompt || undefined,
      batchPrompt: cfg.vision.batchPrompt || undefined,
    },
    audio: {
      mode: cfg.audio.mode,
      prefer: cfg.audio.prefer || undefined,
      language: cfg.audio.language || undefined,
      maxTokens: cfg.audio.maxTokens,
      think: cfg.audio.think,
      prompt: cfg.audio.prompt || undefined,
    },
    video: {
      mode: cfg.video.mode,
      maxFrames: Math.max(1, cfg.video.maxFrames),
      framesHint: cfg.video.framesHint || undefined,
      animatedPrompt: cfg.video.animatedPrompt || undefined,
      framePrefix: cfg.video.framePrefix,
      audioTrackPrefix: cfg.video.audioTrackPrefix,
    },
    animatedImage: {
      maxFrames: Math.max(1, cfg.animatedImage.maxFrames),
    },
    contextHistory: {
      enabled: cfg.contextHistory.enabled,
      maxMessages: Math.max(0, cfg.contextHistory.maxMessages),
    },
    senderContext: {
      enabled: cfg.senderContext.enabled,
      profileMaxChars: Math.max(0, cfg.senderContext.profileMaxChars),
    },
  };
}

const uses = {
  logger,
  config,
  lifecycle,
  events,
  hooks,
  provide,
  proc: processService,
  storage: storageService,
  llm: optional(llm),
  agent: optional(agent),
  asr: optional(asr),
  tools: optional(tools),
  memory: optional(memory),
  sessionManager: optional(sessionManager),
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name,
  displayName: '多模态媒体识别',
  subsystem: 'media',
  configSchema,
  provides: [media],
  uses,
  apply: run,
});

function run(caps: Caps): void {
  const parsed = parseConfig(configSchema, caps.config, caps.logger);
  const cfg = resolveCfg(parsed);
  const logger = caps.logger;
  setMediaRuntime({ proc: createProcessGateway(caps.proc), storage: createStorageGateway(caps.storage) });
  const svc = new MediaServiceImpl(caps, cfg);

  caps.provide(media, svc);

  // 描述缓存续命：识别一次动辄十几秒（动图近一分钟），纯内存缓存重启即全丢。
  // 启动灌回快照、dispose 落盘；读写失败都只降级为「本次不复用」，不影响识别。
  void loadDescriptionCache(logger).then(n => {
    if (n > 0) logger.info(`图片描述缓存已恢复 ${n} 条（跨重启复用，免去重复识别）`);
  });
  caps.lifecycle.onDispose(() => flushDescriptionCache());

  // 参与 memory:clear（/clear 与删除会话）：视频描述（describeVideo 写入）归 video 类型，其余描述归 image 类型，
  // 按所选类型清理。全局清理删掉所选类型的内存条目与别名，两类都清时删掉快照、只清一类时重写快照；
  // 会话级只删带本会话语境的描述（以含会话目录的落盘路径为键），内容哈希键跨会话共享、无从按会话归属，保留。
  caps.hooks.middleware('memory:clear', async (data, next) => {
    const sessionDir = data.scope === 'all' ? undefined : data.sessionId?.replace(/[:/\\]/g, '_');
    const kinds = DESCRIPTION_KINDS.filter(k => !data.types || data.types.includes(k));
    if (kinds.length > 0 && (data.scope === 'all' || sessionDir)) {
      const label = kinds.map(k => DESCRIPTION_KIND_LABELS[k]).join('与');
      try {
        const removed = await clearDescriptionCache(sessionDir, kinds);
        data.results.push({
          source: 'media-description',
          success: true,
          message: sessionDir
            ? `当前会话${label}描述缓存已清空（${removed} 条）`
            : `所有${label}描述缓存已清空（${removed} 条）`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        data.results.push({ source: 'media-description', success: false, message: `${label}描述缓存清空失败: ${msg}` });
      }
    }
    await next();
  });

  // 出口形态变换：agent 组装完成后、发出之前，按交付形态决定末条 user 消息的 images[]
  // 交给主模型什么——describe 清空（识别归识别模型，结果已在正文文字里），passthrough
  // 规范化形态并把动图抽帧（真值表见 service.transformModelImages）。auto 按本会话生效
  // 主模型的 vision 能力现场解析。放中间件而非改 api-media 契约或 plugin-agent——
  // 形态知识整体留在本插件内（契约修改的复杂度与谨慎门槛高于插件内实现）。变换只作用于
  // 末条 user 消息（尾部），不触碰前缀缓存；dryRun 估算轮跳过（抽帧昂贵且该轮不真正发请求）。
  //
  // WeakSet 标记「已处理过的消息」：本钩子在工具循环的每轮迭代都会重跑（上限 30 轮），
  // 而抽帧/物化都要拉远端资源——没有标记的话，一张拉不动的远端动图会在每轮重试
  // （15s 超时 × 30 轮）。每条消息只处理一次，成败皆不重来；消息对象随回合结束被回收，
  // 无生命周期管理。
  const transformed = new WeakSet<object>();
  caps.hooks.middleware('agent:llm:before', async (data, next) => {
    // 所有交付形态都要进来——这道闸此前被模式挡住，于是 describe 模式下
    // agent 塞进 message.images 的历史相对路径 ref（`data/images/…`）一路畅通到 provider，
    // 被当成 base64 送出去，整轮请求被拒（400 illegal base64 data）。
    if (!data.dryRun) {
      for (let i = data.messages.length - 1; i >= 0; i--) {
        const m = data.messages[i];
        if (m.role === 'user' && m.images && m.images.length > 0) {
          if (!transformed.has(m)) {
            transformed.add(m);
            m.images = await svc.transformModelImages(m.images, svc.resolveDelivery(data.sessionId, data.platform));
          }
          break;
        }
      }
    }
    return next();
  });

  // 动态填充 audio.prefer 下拉：把统一池（Whisper/ASR + 音频 LLM）的可选项写进 configSchema。
  // getStatus 读的是 module.configSchema 的 live 对象，故 mutate 即可被前端配置页读到；
  // 随 asr/llm 注册/注销刷新（媒体可能先于其可选依赖加载，apply 时池可能还空）。
  const refreshAudioPrefer = (): void => {
    const group = configSchema.audio;
    if (group && 'fields' in group && group.fields.prefer) {
      (group.fields.prefer as SchemaField).options = [
        { label: '自动（按优先级）', value: '' },
        ...svc.listProcessors('audio').map(p => ({ label: p.displayName ?? p.name, value: p.name })),
      ];
    }
  };
  refreshAudioPrefer();
  for (const ev of ['service:registered', 'service:unregistered'] as const) {
    caps.events.on(ev, (changed: string) => {
      if (changed === 'asr' || changed === 'llm') refreshAudioPrefer();
    });
  }

  // 注册 analyze_image / update_image_description 工具
  registerMediaTools(caps, svc);

  // 注册 preprocessor：agent 不在场时登记留在账上，它上线后自动补挂，随本次激活撤回
  caps.agent.registerPreprocessor('media', buildPreprocessor(caps, svc));
  logger.info(
    `媒体识别预处理器已注册 (vision=${cfg.vision.recognizeOnArrival ? 'recognize-on-arrival' : 'pointer-only'}/${cfg.vision.delivery}, audio=${cfg.audio.mode}, video=${cfg.video.mode})`,
  );
}
