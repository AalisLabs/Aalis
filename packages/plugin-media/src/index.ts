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
import { authority } from '@aalis/api-authority';
import { contributions } from '@aalis/api-contributions';
import { doctor } from '@aalis/api-doctor';
import { events } from '@aalis/api-events';
import { hooks } from '@aalis/api-hooks';
import { llm } from '@aalis/api-llm';
import { clearSessionMedia, media } from '@aalis/api-media';
import { memory } from '@aalis/api-memory';
import { processService } from '@aalis/api-process';
import { sessionManager } from '@aalis/api-session-manager';
import { storage as storageService } from '@aalis/api-storage';
import { tools } from '@aalis/api-tools';
import { type BoundOf, config, definePlugin, lifecycle, logger, optional, provide } from '@aalis/core';
import { type ConfigOf, defineConfig, parseConfig, type SchemaField } from '@aalis/schema-config';
import { type TextRef, textOf } from '@aalis/schema-i18n';
import { clearDescriptionCache, closeDescriptionCache, DESCRIPTION_KINDS, loadDescriptionCache } from './cache.js';
import { DEFAULT_AUDIO_PROMPT, DEFAULT_VISION_BATCH_PROMPT, DEFAULT_VISION_PROMPT } from './llm-adapter.js';
import { buildPreprocessor } from './preprocessor.js';
import { setMediaRuntime } from './runtime.js';
import { MEDIA_WRITER, type MediaConfigResolved, MediaServiceImpl } from './service.js';
import { t } from './texts.js';
import { registerMediaTools } from './tools.js';

const name = '@aalis/plugin-media';

/** /clear 回执里描述缓存类型的称呼（字典键） */
const DESCRIPTION_KIND_NOUNS = { image: 'kindImage', video: 'kindVideo' } as const;

const configSchema = defineConfig({
  vision: {
    label: t('visionLabel'),
    fields: {
      prefer: {
        type: 'llm-ref',
        label: t('visionPreferLabel'),
        description: t('visionPreferDescription'),
      },
      recognizeOnArrival: {
        type: 'boolean',
        label: t('recognizeOnArrivalLabel'),
        default: true,
        description: t('recognizeOnArrivalDescription'),
      },
      delivery: {
        type: 'select',
        label: t('deliveryLabel'),
        options: [
          { label: t('deliveryAuto'), value: 'auto' },
          { label: t('deliveryPassthrough'), value: 'passthrough' },
          { label: t('deliveryDescribe'), value: 'describe' },
        ],
        default: 'auto',
        description: t('deliveryDescription'),
      },
      maxTokens: {
        type: 'number',
        label: t('visionMaxTokensLabel'),
        default: 2048,
        min: 1,
        integer: true,
        onInvalid: 'error',
        description: t('visionMaxTokensDescription'),
      },
      think: {
        type: 'boolean',
        label: t('thinkLabel'),
        default: false,
        description: t('visionThinkDescription'),
      },
      prompt: {
        type: 'textarea',
        label: t('visionPromptLabel'),
        default: '',
        description: t('visionPromptDescription', { prompt: DEFAULT_VISION_PROMPT }),
      },
      batchPrompt: {
        type: 'textarea',
        label: t('batchPromptLabel'),
        default: '',
        description: t('batchPromptDescription', { prompt: DEFAULT_VISION_BATCH_PROMPT }),
      },
    },
  },
  audio: {
    label: t('audioLabel'),
    fields: {
      mode: {
        type: 'select',
        label: t('modeLabel'),
        options: [
          { label: t('audioEnabled'), value: 'enabled' },
          { label: t('audioPassthrough'), value: 'passthrough' },
          { label: t('disabled'), value: 'disabled' },
        ],
        default: 'enabled',
      },
      prefer: {
        type: 'select',
        label: t('audioPreferLabel'),
        // options 在运行时由 media 据已注册的 Whisper/ASR 与音频 LLM 动态补全（见 index.ts refreshAudioPrefer）；
        // 静态列表不全，allowCustom 让校验与解析不按它查取值范围。
        options: [{ label: t('audioPreferAuto'), value: '' }] as Array<{ label: string | TextRef; value: string }>,
        allowCustom: true,
        default: '',
        description: t('audioPreferDescription'),
      },
      language: {
        type: 'string',
        label: t('audioLanguageLabel'),
        default: '',
        description: t('audioLanguageDescription'),
      },
      maxTokens: {
        type: 'number',
        label: t('audioMaxTokensLabel'),
        default: 2048,
        min: 1,
        integer: true,
        onInvalid: 'error',
        description: t('audioMaxTokensDescription'),
      },
      think: {
        type: 'boolean',
        label: t('thinkLabel'),
        default: true,
        description: t('audioThinkDescription'),
      },
      prompt: {
        type: 'textarea',
        label: t('audioPromptLabel'),
        default: '',
        description: t('audioPromptDescription', { prompt: DEFAULT_AUDIO_PROMPT }),
      },
    },
  },
  video: {
    label: t('videoLabel'),
    fields: {
      mode: {
        type: 'select',
        label: t('modeLabel'),
        options: [
          { label: t('videoFramesAsr'), value: 'frames+asr' },
          { label: t('videoFramesOnly'), value: 'frames-only' },
          { label: t('disabled'), value: 'disabled' },
        ],
        default: 'frames+asr',
      },
      maxFrames: { type: 'number', label: t('maxFramesLabel'), default: 5 },
      framesHint: {
        type: 'textarea',
        label: t('framesHintLabel'),
        default: '',
        description: t('framesHintDescription'),
      },
      animatedPrompt: {
        type: 'textarea',
        label: t('animatedPromptLabel'),
        default: '',
        description: t('animatedPromptDescription'),
      },
      framePrefix: {
        type: 'string',
        label: t('framePrefixLabel'),
        default: '[画面] ',
        description: t('framePrefixDescription'),
      },
      audioTrackPrefix: {
        type: 'string',
        label: t('audioTrackPrefixLabel'),
        default: '[音轨] ',
        description: t('audioTrackPrefixDescription'),
      },
    },
  },
  animatedImage: {
    label: t('animatedImageLabel'),
    fields: {
      maxFrames: {
        type: 'number',
        label: t('maxFramesLabel'),
        default: 5,
        description: t('animatedMaxFramesDescription'),
      },
    },
  },
  contextHistory: {
    label: t('contextHistoryLabel'),
    fields: {
      enabled: {
        type: 'boolean',
        label: t('contextHistoryEnabledLabel'),
        default: true,
        description: t('contextHistoryEnabledDescription'),
      },
      maxMessages: {
        type: 'number',
        label: t('contextHistoryMaxMessagesLabel'),
        default: 4,
      },
    },
  },
  senderContext: {
    label: t('senderContextLabel'),
    fields: {
      enabled: {
        type: 'boolean',
        label: t('senderContextEnabledLabel'),
        default: true,
        description: t('senderContextEnabledDescription'),
      },
      profileMaxChars: {
        type: 'number',
        label: t('profileMaxCharsLabel'),
        default: 200,
        description: t('profileMaxCharsDescription'),
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
  authority: optional(authority),
  doctor: optional(doctor),
  /** 登记 /clear 的 image、video 类型 */
  contributions: optional(contributions),
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name,
  displayName: t('displayName'),
  subsystem: 'media',
  configSchema,
  provides: [media],
  uses,
  apply: run,
});

function run(caps: Caps): void {
  const parsed = parseConfig(configSchema, caps.config.use, caps.logger.use);
  const cfg = resolveCfg(parsed);
  const logger = caps.logger.use;
  setMediaRuntime({ proc: caps.proc.use, storage: caps.storage.use });
  const svc = new MediaServiceImpl(caps, cfg);

  caps.provide.use(media, svc);

  // 没有模型看得到图时图照样落盘、正文写明看不了（见 service.recognizeMessage），整体缺了看图能力要让用户在诊断里看到
  caps.doctor.use.registerCheck({
    id: 'media.vision',
    category: 'service',
    run() {
      const vision = svc.imageDescriber();
      return vision
        ? {
            id: 'media.vision',
            category: 'service',
            level: 'ok',
            message: t('visionReady', { model: vision.displayName ?? vision.name }),
          }
        : {
            id: 'media.vision',
            category: 'service',
            level: 'warn',
            message: t('visionUnavailable'),
            detail: t('visionUnavailableFix'),
          };
    },
  });

  // 描述缓存续命：识别一次动辄十几秒（动图近一分钟），纯内存缓存重启即全丢。
  // 启动灌回快照、dispose 落盘；读写失败都只降级为「本次不复用」，不影响识别。
  void loadDescriptionCache(logger).then(n => {
    if (n > 0) logger.info(`图片描述缓存已恢复 ${n} 条（跨重启复用，免去重复识别）`);
  });
  caps.lifecycle.use.onDispose(() => closeDescriptionCache());

  // 参与 memory:clear（/clear 与删除会话），按所选类型清理，各行标 type：
  // - 上传的图片（本插件在会话媒体目录里的子目录）归 image：会话级清这个会话的，全局清各会话的；
  // - 描述缓存：视频描述（describeVideo 写入）归 video，其余描述归 image，各回一行。全局清理删掉所选类型的内存条目与
  //   别名，两类都清时删掉快照、只清一类时重写快照；会话级只删键落在本会话媒体目录下的描述（带本会话语境的、文件名
  //   不是内容哈希的），内容哈希键跨会话共享、无从按会话归属，保留。
  // 两个类型都登记，/clear -t 才选得中（别的写入方也登记同名类型，帮助里只列一次）。
  caps.contributions.use.contribute('memory:clear-type', { id: 'image', label: t('clearTypeImage') });
  caps.contributions.use.contribute('memory:clear-type', { id: 'video', label: t('clearTypeVideo') });
  caps.hooks.use.middleware('memory:clear', async (data, next) => {
    const sessionId = data.scope === 'all' ? undefined : data.sessionId;
    if (data.scope === 'all' || sessionId) {
      if (!data.types || data.types.includes('image')) {
        const line = { source: 'media-image', type: 'image' };
        try {
          const count = await clearSessionMedia(caps.storage.use, 'image', MEDIA_WRITER, sessionId);
          data.results.push({ ...line, success: true, message: t('uploadsCleared', { count }) });
        } catch (err) {
          data.results.push({ ...line, success: false, message: t('uploadsFailed', { error: textOf(err) }) });
        }
      }
      const kinds = DESCRIPTION_KINDS.filter(k => !data.types || data.types.includes(k));
      if (kinds.length > 0) {
        const source = 'media-description';
        try {
          const removed = await clearDescriptionCache(sessionId, kinds, caps.lifecycle.use.signal);
          for (const type of kinds) {
            const params = { kind: t(DESCRIPTION_KIND_NOUNS[type]), count: removed[type] };
            const message = t(sessionId ? 'descriptionsClearedSession' : 'descriptionsClearedAll', params);
            data.results.push({ source, type, success: true, message });
          }
        } catch (err) {
          for (const type of kinds) {
            const message = t('descriptionsFailed', { kind: t(DESCRIPTION_KIND_NOUNS[type]), error: textOf(err) });
            data.results.push({ source, type, success: false, message });
          }
        }
      }
    }
    await next();
  });

  // 出口形态变换：agent 组装完成后、发出之前，按交付形态决定带图的 user 消息的 images[]
  // 交给主模型什么——describe 清空（识别归识别模型，结果已在正文文字里），passthrough
  // 规范化形态并把动图抽帧（真值表见 service.transformModelImages）。auto 按 agent 交来的
  // data.acceptsImages（这一轮的主模型能不能看图）。放中间件而非改 api-media 契约或 plugin-agent——
  // 形态知识整体留在本插件内（契约修改的复杂度与谨慎门槛高于插件内实现）。带图的只有这一轮的
  // 输入（agent 只给这一轮的输入挂图，历史消息不带图），每条都变换（插进来的输入各带各的图），
  // 不触碰前缀缓存；dryRun 估算轮跳过（抽帧昂贵且该轮不真正发请求）。
  //
  // WeakSet 标记「已处理过的消息」：本钩子在工具循环的每轮迭代都会重跑（轮数默认不限），
  // 而抽帧/物化都要下载远端资源——没有标记的话，一张获取失败的远端动图会在每轮重试
  // （每轮 15s 超时）。每条消息只处理一次，成败皆不重来；消息对象随回合结束被回收，
  // 无生命周期管理。
  const transformed = new WeakSet<object>();
  caps.hooks.use.middleware('agent:llm:before', async (data, next) => {
    // 所有交付形态都要进来——这道闸此前被模式挡住，于是 describe 模式下
    // agent 放入 message.images 的附件引用一路畅通到 provider，
    // 被当成 base64 送出去，整轮请求被拒（400 illegal base64 data）。
    if (!data.dryRun) {
      for (const m of data.messages) {
        if (m.role !== 'user' || !m.images?.length || transformed.has(m)) continue;
        transformed.add(m);
        try {
          m.images = await svc.transformModelImages(m.images, svc.resolveDelivery(data.acceptsImages), data.signal);
        } catch (err) {
          // 抽帧与下载只在中止时抛出：本插件停用或重启时这条的图不再交出，这一轮照常往下，不因停用让整轮失败；
          // 这一轮被停下时照抛中止原因，这一轮按中止收尾
          if (!caps.lifecycle.use.signal.aborted) throw err;
          m.images = [];
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
        { label: t('audioPreferAuto'), value: '' },
        ...svc.listProcessors('audio').map(p => ({ label: p.displayName ?? p.name, value: p.name })),
      ];
    }
  };
  refreshAudioPrefer();
  caps.asr.watch(refreshAudioPrefer);
  caps.llm.watch(refreshAudioPrefer);

  // 注册 analyze_image / update_image_description 工具
  registerMediaTools(caps, svc);

  // 注册 preprocessor：agent 不在场时登记留在归属表里，它上线后自动补挂，随本次激活撤回
  caps.agent.use.registerPreprocessor('media', buildPreprocessor(caps, svc));
  logger.info(
    `媒体识别预处理器已注册 (vision=${cfg.vision.recognizeOnArrival ? 'recognize-on-arrival' : 'pointer-only'}/${cfg.vision.delivery}, audio=${cfg.audio.mode}, video=${cfg.video.mode})`,
  );
}
