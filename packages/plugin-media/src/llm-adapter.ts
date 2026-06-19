// ============================================================
// llm-adapter.ts — 把声明了 vision/audio 能力的 LLM 自动包装为 MediaProcessor
// ============================================================

import { Buffer } from 'node:buffer';
import type { Context } from '@aalis/core';
import type { LLMModel, LLMModelEntry } from '@aalis/plugin-llm-api';
import { LLMCapabilities } from '@aalis/plugin-llm-api';
import type {
  DescribeInput,
  DescribeResult,
  MediaCapability,
  MediaProcessor,
  TranscribeInput,
  TranscribeResult,
} from '@aalis/plugin-media-api';
import type { Message } from '@aalis/plugin-message-api';
import { materializeAttachment, transcodeAudioToWav } from './ffmpeg.js';

export const DEFAULT_VISION_PROMPT =
  '请像有经验的朋友一样看这张图，用自然中文客观描述实际可见的内容。' +
  '先抓 1–2 个最值得注意的视觉重点——优先选「视觉意外/反常之处」：信息密度异常集中的区域、' +
  '数量反常多或反常少的物体、与画面其他部分明显冲突的颜色或元素、不该出现却出现的东西、' +
  '醒目的文字或表情包文案、明显的游戏/二次元/网络梗标志，再补充主体、场景、人物动作与表情、整体氛围。' +
  '如果画面是某游戏、动画、网络梗的标志性元素，请直接点名识别（例如 Minecraft 的草方块/羊驼/红石/刷怪塔/' +
  'iron farm、原神角色、明日方舟干员、知名表情包模板等），不要只说"一些方块"。\n\n' +
  '画面中若有数字（连胜天数、分数、价格、等级、日期、计数等），务必逐位看准、按画面实际像素如实读出，' +
  '不要受对话上下文里出现过的旧数字影响（以图为准）。\n\n' +
  '**严格约束**：只描述图片本身可见的内容；不要主动推测发送者的情绪、动机、意图或心理状态，' +
  '也不要把上下文/对话历史里提到但图片中不可见的人物、事件、动机写进描述。' +
  '只有当图中文字、表情包文案、画面元素自身明确表达了某种情绪或动作意图（例如表情包模板自带语义、' +
  '画面里有醒目的「求助」/「炫耀」文字等）时，才可以简短指出该信号。\n\n' +
  '控制在 200 字以内，不要 markdown，不要按 1)2)3) 列点，写成 1–2 段连贯文字。';

/**
 * Vision 详细描述 prompt：用于一般信息密度较高的图片（文档/PPT/代码/表格/截图/网络梗等）。
 * 不限字数，聚焦"图像整体详情识别"，**不与某一学科绑定**。
 * 学科题目（数学/物理/化学等需要严格 LaTeX 与几何坐标识别）请使用 `professional` 档位。
 * 选用条件：用户/agent 显式 detail_level='detailed'，或两阶段分类判定为 document/mixed。
 */
export const DEFAULT_VISION_DETAILED_PROMPT =
  '请用中文详细描述这张图片中的全部可识别内容，不限字数，确保信息完整：' +
  '描述主要场景、整体布局、画面中所有可见元素（人物、物体、文字、图形、UI 界面、表情包/网络梗、游戏/动画标志性元素）；' +
  '对游戏/动画/网络梗的标志性元素请直接点名识别（如 Minecraft 草方块/羊驼、原神角色、明日方舟干员、知名表情包模板等），' +
  '不要只说"一些方块"；' +
  '完整抄录所有可辨认文字（标题、正文、按钮、标签、UI 文字、水印），含字母大小写与标点；' +
  '遇到公式、化学反应式或科学符号时可以用 LaTeX 包在 $...$ 里，但不强制；' +
  '代码截图请逐行抄录代码并用 Markdown 代码块标注语言；表格请用 Markdown 表格语法逐行抄录；' +
  '文档/PPT/书页请按视觉层级列出标题与要点；' +
  '若含手写笔迹/批注/箭头标记请单独说明位置和内容；' +
  '最后用一句话点明图片类型与发送者可能的意图。' +
  '如果图片是数学/物理/化学等专业学科题目（需要逐题列题号、强 LaTeX 公式、几何坐标识别等），' +
  '建议上游使用 professional 档位以获得更严格的识别；本档位重点是图像整体详情而非学科结构。' +
  '宁可多说不要漏说。';

/**
 * Vision 专业学科题目 prompt（v5）：用于数学/物理/化学等"专业题目"图片，要求严格 LaTeX 与坐标识别。
 * 设计要点：
 * - 紧凑散文式，避免编号小标题（防止结构 echo）
 * - 强制使用标准 LaTeX 命令（如 `\complement_U A` 而非 `C_U A`）
 * - 几何图必须先验证边长再下形状结论（防止"正方形 FEDC"幻觉）
 * - 自适应：不是题目时不套题号/ABCD 格式，正确点明类型（函数图/笔记/代码 等）
 * 选用条件：用户/agent 显式 detail_level='professional'，或两阶段分类判定为 professional 类。
 */
export const DEFAULT_VISION_PROFESSIONAL_PROMPT =
  '请完整识别这张图片中实际存在的全部内容，用自然中文连续叙述，不要使用编号小标题（如「文字部分：」「公式：」）' +
  '也不要回显本提示词。\n\n' +
  '先用一句话点明图片类型（例如：数学选择题、物理大题含受力图、化学反应式、笔记、代码、表格、几何图、函数图、电路图等），' +
  '再开始详细识别。\n\n' +
  '识别要求：' +
  '完整抄录图中所有可辨认文字，每个字符都不要漏（含字母大小写、上下标、希腊字母、数字、单位、标点）；' +
  '公式与符号用 LaTeX 包在 $...$ 或 $$...$$ 里，使用标准命令——补集 $\\complement_U A$（不要写 $C_U A$）、' +
  '并/交集 $\\cup\\cap$、属于 $\\in$、向量 $\\vec{a}$ 或 $\\overrightarrow{AB}$、积分 $\\int$、求和 $\\sum$、' +
  '极限 $\\lim$、分式 $\\frac{}{}$、根号 $\\sqrt{}$、矩阵 $\\begin{pmatrix}\\end{pmatrix}$、' +
  '化学反应式带配平系数与状态箭头、物理量保留单位（m/s、N、Pa、mol/L 等）。\n\n' +
  '如果图中确实是题目，按原题保留题号、小问、选项编号；不是题目就不要套题号或 ABCD 格式。\n\n' +
  '如果题目附带几何图、函数图、电路图、受力图、化学结构、统计图等示意图：' +
  '列出图中所有标注的字母点（能从坐标轴读数则写坐标，**坐标必须仔细读，不要把不同点错配到同一坐标**）；' +
  '列出图中所有可见的线段、曲线、辅助线（含多边形主体边与彩色高亮线，不同颜色单独说明）；' +
  '列出图中明确标注的角度、长度、比例、垂直/平行符号；' +
  '从顶点坐标可无歧义判定形状时可断言（必须先按顺序列出参与该形状的顶点序列，验证每条边长度后再下结论；' +
  '**若任何一条边长度为 0 或两点坐标重合，则不构成多边形，立即放弃该形状判断**）；' +
  '函数图说明类型、零点、极值、渐近线；电路图列出元件、连接、读数。\n\n' +
  '只描述图中实际存在的内容。图中无手写笔迹就不要提手写；无图形就不要列顶点；无选项就不要写 ABCD。\n' +
  '图片标题或文字若因字体缺失显示为方块（□□□），写「标题区域为乱码方块」即可，不要硬猜内容。\n\n' +
  '最后用一句话总结图片核心信息与发送者可能的意图。宁可漏说细节，也不要瞎编。';

/**
 * 两阶段轻量分类 prompt：要求模型从 4 个标签里选一个，让客户端据此挑专业/详细/简洁 prompt。
 * 设计目标：极短输出、易解析、覆盖率高。fallback 一律按 detailed 处理。
 */
export const VISION_CLASSIFY_PROMPT =
  '只用一个英文标签回答这张图片属于哪类，**只输出标签本身**，不要任何解释或标点：\n' +
  '- `professional`：数学题、物理题、化学题、生物题、考试卷、含 LaTeX 公式/几何图/受力图/电路图/化学反应式的学科题目\n' +
  '- `document`：非学科类的文档、PPT、书页、代码截图、表格、长截图、网页/文章截图、含密集文字的图\n' +
  '- `casual`：聊天截图、表情包/梗图、游戏截图、生活照、宠物/人物自拍、风景\n' +
  '- `mixed`：含少量文字但主要是图像内容（如带文案的截图、海报、漫画格）\n' +
  '默认 unknown 时也只输出 `document`（保守原则，宁详勿略）。';

export const DEFAULT_VISION_BATCH_PROMPT =
  '以下是一组按顺序排列的图片，请综合所有图片做一段连贯的中文描述。先抓住整组图最值得注意的点：' +
  '是同一场景的连拍/抽帧、还是各自独立的素材？是否构成时序变化、对比、剧情或梗？' +
  '其次描述主体对象、人物动作、文字/表情包文案，并对画面中的游戏/动画/网络梗标志性元素直接点名识别' +
  '（如 Minecraft 草方块/羊驼/刷怪塔、原神角色、明日方舟干员、知名表情包模板等）。' +
  '最后简短推测整组图想表达的事件、情绪或意图。' +
  '画面中若有数字（分数、价格、计数、天数等）务必按实际像素逐位读准，不受上下文旧数字影响。' +
  '控制在 250 字以内，不要 markdown，不要按 1)2)3) 列点，写成连贯文字。';

// 全能音频 prompt：语音转写为原文 + 音乐/环境音描述。
// 注意：e4b 这类小模型在 thinking enabled 时此类开放式 prompt 会消耗
// ~600-900 completion token；要求 maxTokens 至少 1024，否则会被截断为空。
// 详见 /memories/repo/aalis-ollama-gemma4-audio.md。
export const DEFAULT_AUDIO_PROMPT =
  '请用中文描述这段音频的内容：' +
  '若含语音/对话则转写为原文（中文用中文写，英文保留英文）；' +
  '若含音乐则描述风格、乐器、情绪及可识别歌词；' +
  '若是环境音/音效则描述场景；' +
  '仅输出内容本身，不要 markdown 标记。';

interface LlmProcessorOptions {
  /** 自定义 prompt 覆盖默认值（单图 / audio / video.passthrough） */
  prompt?: string;
  /** 多图批量描述专用 prompt，仅 vision 生效。留空使用 prompt（若也为空则用内置默认） */
  batchPrompt?: string;
  /** 最大输出 tokens */
  maxTokens?: number;
  /**
   * 是否启用 thinking（思考链）。
   * - true（默认）：模型先内部推理后输出，质量更好但 token 消耗 ~5-8 倍
   * - false：直接输出，token 省但全能 prompt 下偶发 echo prompt
   * 对 Ollama OpenAI 兼容路径会翻译为 `reasoning_effort: "none"`。
   */
  think?: boolean;
}

/**
 * 通过 magic header 探测音频格式，仅用于诊断 / 拒绝不支持的格式。
 * 返回简短格式名（mp3/wav/ogg/m4a/amr/silk/unknown）。
 */
function detectAudioFormat(buf: Buffer): string {
  if (buf.length < 12) return 'unknown';
  // SILK V3：QQ 语音原生格式，前 1 字节可能为 0x02（"flags" 前缀），随后 "#!SILK_V3"
  const silkHead = buf[0] === 0x02 ? buf.subarray(1, 10) : buf.subarray(0, 9);
  if (silkHead.toString('ascii') === '#!SILK_V3') return 'silk';
  // AMR：'#!AMR\n' 或 '#!AMR-WB\n'
  if (buf.subarray(0, 5).toString('ascii') === '#!AMR') return 'amr';
  // mp3：'ID3' 或 MPEG 同步帧 0xFFEx / 0xFFFx
  if (buf.subarray(0, 3).toString('ascii') === 'ID3') return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  // WAV：'RIFF....WAVE'
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WAVE') return 'wav';
  // OGG：'OggS'
  if (buf.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg';
  // M4A / MP4：offset 4 'ftyp'
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') return 'm4a';
  // FLAC：'fLaC'
  if (buf.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac';
  return 'unknown';
}

/**
 * 把 audio attachment.data 解析为 base64（去掉 data: 前缀），供 LLM provider 直接使用。
 *
 * 处理策略：
 * 1. 物化到本地文件
 * 2. 探测 magic header；mp3/wav/ogg/m4a/flac 等主流格式直接透传
 * 3. 其它格式（含 OneBot/NapCat 常见的 amr 与 raw audio）一律用 ffmpeg
 *    转码为 16kHz mono WAV，这是 Gemma 3n 等多模态 LLM 官方推荐的格式
 * 4. ffmpeg 转码失败（典型如 SILK——ffmpeg 没有 silk 解码器）才抛错
 */
import { getMediaRuntime } from './runtime.js';

/**
 * 把 image attachment.data 规范化为 `data:image/...;base64,...` 形式，
 * 供 LLM provider 直接消费。处理策略：
 * - 已经是 `data:image/...;base64,...` → 原样返回
 * - http(s) URL → 原样返回（由 provider 自行下载）
 * - 其他形式（storage URI `data:/...`、相对路径 `data/...`、file://、绝对路径）
 *   → 走 materializeAttachment 物化到 storage，读出字节后转为 data URL
 *
 * 历史上 adapter-onebot 直接把 `data/images/...` 这种"相对路径 ref"塞进
 * att.data。ollama provider 的 resolveBinary 只认 data URI / http / file:// / 绝对路径，
 * 这种 bare 相对路径会被原样当作 base64 送给 Ollama，触发 `illegal base64 data at input byte N`。
 * 在 media 层统一规范化为 data URL 后，所有 vision provider 都能正确解码。
 */
async function imageToBase64DataUrl(data: string, mimeType?: string): Promise<string> {
  if (/^data:image\/[^;]+;base64,/.test(data)) return data;
  if (/^https?:\/\//i.test(data)) return data;
  const mat = await materializeAttachment(data);
  if (!mat) throw new Error(`无法物化图片附件: ${data.slice(0, 80)}`);
  try {
    const { storage } = getMediaRuntime();
    let buf: Buffer;
    if (mat.uri) {
      const raw = (await storage.readFile(mat.uri)) as Uint8Array;
      buf = Buffer.from(raw);
    } else {
      const { proc } = getMediaRuntime();
      const raw = await proc.readExternalFile(mat.path);
      buf = Buffer.from(raw);
    }
    // 尝试基于扩展名 / 显式 mime 推断；缺省走 png（绝大多数 vision provider 都接受）
    const ext = mat.path.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase();
    const mime = mimeType ?? (ext ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : 'image/png');
    return `data:${mime};base64,${buf.toString('base64')}`;
  } finally {
    await mat.cleanup();
  }
}

/**
 * 将 fmt（detectAudioFormat 输出）映射为 audio/* mime 子类型。
 * 注意 mp3 → audio/mpeg（IANA 标准），其余直接同名。
 */
function fmtToMime(fmt: string): string {
  if (fmt === 'mp3') return 'audio/mpeg';
  if (fmt === 'wav') return 'audio/wav';
  if (fmt === 'ogg') return 'audio/ogg';
  if (fmt === 'm4a') return 'audio/mp4';
  if (fmt === 'flac') return 'audio/flac';
  return 'audio/wav'; // 转码兜底永远是 WAV
}

/**
 * 把 audio attachment.data 解析为 **带 mime 前缀的 data URL**，供 LLM provider 直接使用。
 *
 * 历史 bug（修复 2026-05）：以前返回纯 base64，下游 ollama 的
 * `decodeAudioForOpenAI` 因为拿不到 mime 信息只能 fallback 到 `format=wav`；
 * 而 `extractAudioTrack` 输出的实际是 mp3 → ollama runner 把 mp3 字节当 wav
 * 解析失败，报 "image: unknown format"。
 *
 * 现在统一返回 `data:audio/{mime};base64,...`：
 * - `decodeAudioForOpenAI` 能精确推断 format
 * - `stripAudioDataPrefix`（/api/chat 路径）能正确剥前缀
 * - 兼容性：Message.audios 字段就是 string[]，data URL 仍然合法
 */
async function audioToBase64(data: string): Promise<string> {
  const mat = await materializeAttachment(data);
  if (!mat) throw new Error(`无法物化音频附件: ${data.slice(0, 80)}`);
  try {
    if (!mat.uri) {
      throw new Error('音频附件未落入 storage 根（请让 adapter 先走 attachment-cache）');
    }
    const { storage } = getMediaRuntime();
    const raw = (await storage.readFile(mat.uri)) as Uint8Array;
    const buf = Buffer.from(raw);
    const fmt = detectAudioFormat(buf);

    // 主流格式：多模态 LLM 与 Whisper 都能直接解码，无需转码
    if (fmt === 'mp3' || fmt === 'wav' || fmt === 'ogg' || fmt === 'm4a' || fmt === 'flac') {
      return `data:${fmtToMime(fmt)};base64,${buf.toString('base64')}`;
    }

    // 其它格式（amr / silk / unknown / 裸 PCM 等）一律走 ffmpeg 转 WAV
    const wav = await transcodeAudioToWav(mat.path);
    if (!wav) {
      throw new Error(
        `音频格式为 ${fmt}，ffmpeg 无法转码为 WAV（可能是 SILK 或加密格式）；` +
          '请检查 OneBot 实现端 get_record 是否真正执行了 silk→mp3 转码',
      );
    }
    return `data:audio/wav;base64,${wav}`;
  } finally {
    await mat.cleanup();
  }
}

/** 把单个 LLMModelEntry 包装成 MediaProcessor。 */
function wrapLLMAsProcessor(
  entry: LLMModelEntry,
  cap: MediaCapability,
  opts: LlmProcessorOptions = {},
): MediaProcessor {
  const llm: LLMModel = entry.instance;
  const name = `llm:${entry.contextId}#${capShortName(cap)}`;
  const proc: MediaProcessor = {
    name,
    capabilities: [cap],
    displayName: `${entry.label ?? entry.contextId} (${capShortName(cap)})`,
    priority: 0,
    async describe(input: DescribeInput, _ctx: Context): Promise<DescribeResult> {
      // base 优先级：调用方显式 basePrompt > wrap 时注入的 opts.prompt > 内置默认
      // 调用方需要切换 prompt（如分类/详细/专业模式）时必须传 input.basePrompt，
      // 不要塞进 hint —— 否则会和默认 base 同时存在产生指令冲突。
      const explicitBase = input.basePrompt;
      const base =
        explicitBase ??
        (cap === 'vision' && input.attachments.length > 1
          ? (opts.batchPrompt ?? opts.prompt ?? DEFAULT_VISION_BATCH_PROMPT)
          : (opts.prompt ?? defaultPromptFor(cap, input.attachments.length)));
      // 上下文仅作背景参考，必须显式防止"上下文污染描述"：模型容易把对话历史里出现、
      // 但图片中并不可见的人物/事件/情绪写进描述，导致"夸张"或事实捏造。
      const ctxBlock = input.context
        ? `\n\n上下文/最近对话（仅供理解参考，禁止写入描述）:\n${input.context}\n\n` +
          '⚠️ 严格要求：上下文只用于辅助理解图片含义（如对话谈到的话题可能与图片相关），' +
          '描述本身必须只包含图片中实际可见的内容。禁止把上下文里提及但图片中不可见的' +
          '人物、地点、事件、情绪、动机写进描述。'
        : '';
      const hintBlock = input.hint ? `\n\n额外要求：${input.hint}` : '';
      const prompt = `${base}${ctxBlock}${hintBlock}`;
      // audio 默认更大：e4b thinking enabled 时全能 prompt 消耗 ~600-900 token
      const defaultMax = cap === 'audio' ? 1024 : 300;
      const maxTokens = input.maxTokens ?? opts.maxTokens ?? defaultMax;
      // audio 默认保留 thinking（识别质量更高）；其他 cap 维持原 false 行为。
      const think = opts.think ?? cap === 'audio';

      // image / video.passthrough 走 images[] 字段
      // 视频帧已被预处理拆为图片再调用本方法。
      if (cap === 'vision' || cap === 'document.image' || cap === 'video.passthrough') {
        const images = await Promise.all(input.attachments.map(a => imageToBase64DataUrl(a.data, a.mimeType)));
        const sizesKB = images.map(s => Math.round((s.length * 3) / 4 / 1024));
        const messages: Message[] = [{ role: 'user', content: prompt, images }];
        const t0 = Date.now();
        _ctx.logger.info(
          `[${cap}.describe] 调用 ${llm.id}，${images.length} 张图 (${sizesKB.join('/')}KB), ` +
            `prompt=${prompt.length}字, maxTokens=${maxTokens}, think=${think}`,
        );
        const resp = await llm.chat({ messages, maxTokens, think });
        const rawLen = resp.content?.length ?? 0;
        const text = resp.content?.trim() ?? '';
        const usedTokens = resp.usage?.totalTokens;
        if (rawLen === 0) {
          const usedPct = usedTokens && maxTokens > 0 ? Math.round((usedTokens / maxTokens) * 100) : -1;
          _ctx.logger.warn(
            `[${cap}.describe] ${llm.id} 空响应：${Date.now() - t0}ms, sizesKB=[${sizesKB.join('/')}], ` +
              `prompt=${prompt.length}字, tokens=${usedTokens ?? '?'}/${maxTokens}` +
              (usedPct >= 80
                ? `（占用 ${usedPct}%，可能是 maxTokens 不足导致 completion 被截空）`
                : usedPct >= 0
                  ? `（占用 ${usedPct}%）`
                  : '') +
              `, think=${think}`,
          );
        } else {
          _ctx.logger.info(
            `[${cap}.describe] ${llm.id} 完成 ${Date.now() - t0}ms, raw=${rawLen}字 trim=${text.length}字, tokens=${usedTokens ?? '?'}`,
          );
        }
        return {
          descriptions: input.mode === 'single' ? input.attachments.map(() => text) : [text],
          meta: { processor: name, model: llm.id, tokens: usedTokens },
        };
      }

      if (cap === 'audio') {
        // 把音频附件转 base64 后放到 Message.audios，由 provider 适配（如 plugin-ollama 走 chat-completions audio 块）
        const audios = await Promise.all(input.attachments.map(a => audioToBase64(a.data)));
        const sizesKB = audios.map(a => Math.round((a.length * 3) / 4 / 1024));
        const messages: Message[] = [{ role: 'user', content: prompt, audios }];
        const t0 = Date.now();
        _ctx.logger.info(
          `[audio.describe] 调用 ${llm.id}，${audios.length} 段音频 (${sizesKB.join('/')}KB), ` +
            `prompt=${prompt.length}字, maxTokens=${maxTokens}, think=${think}`,
        );
        const resp = await llm.chat({ messages, maxTokens, think });
        const rawLen = resp.content?.length ?? 0;
        const text = resp.content?.trim() ?? '';
        const usedTokens = resp.usage?.totalTokens;
        if (rawLen === 0) {
          const usedPct = usedTokens && maxTokens > 0 ? Math.round((usedTokens / maxTokens) * 100) : -1;
          _ctx.logger.warn(
            `[audio.describe] ${llm.id} 空响应：${Date.now() - t0}ms, sizesKB=[${sizesKB.join('/')}], ` +
              `prompt=${prompt.length}字, tokens=${usedTokens ?? '?'}/${maxTokens}` +
              (usedPct >= 80
                ? `（占用 ${usedPct}%，可能是 maxTokens 不足导致 completion 被截空）`
                : usedPct >= 0
                  ? `（占用 ${usedPct}%）`
                  : '') +
              `, think=${think}`,
          );
        } else {
          _ctx.logger.info(
            `[audio.describe] ${llm.id} 完成 ${Date.now() - t0}ms, raw=${rawLen}字 trim=${text.length}字, tokens=${usedTokens ?? '?'}, ` +
              `内容="${(resp.content ?? '').replace(/\n/g, ' ').slice(0, 200)}${rawLen > 200 ? '…' : ''}"`,
          );
        }
        return {
          descriptions: input.mode === 'single' ? input.attachments.map(() => text) : [text],
          meta: { processor: name, model: llm.id, tokens: usedTokens },
        };
      }

      throw new Error(`LLM adapter 不支持 capability=${cap}`);
    },
  };

  if (cap === 'audio') {
    proc.transcribe = async (input: TranscribeInput, _ctx: Context): Promise<TranscribeResult> => {
      const langHint = input.language ? `\n* 输出语言：${input.language}` : '';
      const ctxBlock = input.context ? `\n\n上下文/最近对话:\n${input.context}` : '';
      const prompt = `${opts.prompt ?? DEFAULT_AUDIO_PROMPT}${langHint}${ctxBlock}`;
      const b64 = await audioToBase64(input.attachment.data);
      const sizeKB = Math.round((b64.length * 3) / 4 / 1024);
      const audios = [b64];
      const messages: Message[] = [{ role: 'user', content: prompt, audios }];
      const maxTokens = opts.maxTokens ?? 1024;
      const think = opts.think ?? true;
      const t0 = Date.now();
      _ctx.logger.info(
        `[audio.transcribe] 调用 ${llm.id}，音频 ${sizeKB}KB, prompt ${prompt.length}字, maxTokens=${maxTokens}, think=${think}`,
      );
      const resp = await llm.chat({ messages, maxTokens, think });
      const rawLen = resp.content?.length ?? 0;
      const text = (resp.content ?? '').trim();
      const usedTokens = resp.usage?.totalTokens;
      if (rawLen === 0) {
        // 空响应通常不是“非语音”——而是 maxTokens 不足 / prompt+音频 token 占用过高 / 模型超时。
        // 把可能原因都打出来，便于排查 nemotron/gemma 等模型的资源不足情况。
        const usedPct = usedTokens && maxTokens > 0 ? Math.round((usedTokens / maxTokens) * 100) : -1;
        _ctx.logger.warn(
          `[audio.transcribe] ${llm.id} 空响应：${Date.now() - t0}ms, sizeKB=${sizeKB}, prompt=${prompt.length}字, ` +
            `tokens=${usedTokens ?? '?'}/${maxTokens}` +
            (usedPct >= 80
              ? `（占用 ${usedPct}%，可能是 maxTokens 不足导致 completion 被截空，建议调高 audio.maxTokens 到 2048+）`
              : usedPct >= 0
                ? `（占用 ${usedPct}%）`
                : '') +
            `, think=${think}`,
        );
      } else {
        _ctx.logger.info(
          `[audio.transcribe] ${llm.id} 完成 ${Date.now() - t0}ms, raw=${rawLen}字 trim=${text.length}字, tokens=${usedTokens ?? '?'}, ` +
            `内容="${(resp.content ?? '').replace(/\n/g, ' ')}"`,
        );
      }
      return {
        text,
        language: input.language,
        meta: { processor: name, model: llm.id },
      };
    };
  }

  return proc;
}

function capShortName(cap: MediaCapability): string {
  switch (cap) {
    case 'vision':
      return 'vision';
    case 'audio':
      return 'audio';
    case 'video.passthrough':
      return 'video';
    case 'document.image':
      return 'doc-img';
  }
}

function defaultPromptFor(cap: MediaCapability, count: number): string {
  if (cap === 'audio') return DEFAULT_AUDIO_PROMPT;
  if (count > 1) return DEFAULT_VISION_BATCH_PROMPT;
  return DEFAULT_VISION_PROMPT;
}

/**
 * 扫描当前 ctx 中所有 LLM entry，按其声明的能力返回应注册的 MediaProcessor 数组。
 */
/**
 * 扫描当前 ctx 中所有 LLM entry，按其声明的能力返回应注册的 MediaProcessor 数组。
 * @param opts 默认应用于所有 cap 的参数，以及 per-cap 覆盖（vision/audio/video 可独立配 prompt/maxTokens/think）
 */
export function scanLLMProcessors(
  ctx: Context,
  opts: LlmProcessorOptions & {
    vision?: LlmProcessorOptions;
    audio?: LlmProcessorOptions;
    video?: LlmProcessorOptions;
  } = {},
): MediaProcessor[] {
  const { vision: visionOverride, audio: audioOverride, video: videoOverride, ...defaults } = opts;
  const processors: MediaProcessor[] = [];
  const all = ctx.getAllServices<LLMModel>('llm');
  for (const entry of all) {
    const caps = entry.instance.capabilities;
    if (caps.includes(LLMCapabilities.Vision)) {
      processors.push(wrapLLMAsProcessor(entry, 'vision', { ...defaults, ...visionOverride }));
      processors.push(wrapLLMAsProcessor(entry, 'document.image', { ...defaults, ...visionOverride }));
    }
    if (caps.includes(LLMCapabilities.Audio)) {
      // Gemma 3n / Gemini / GPT-4o-audio 等原生音频 LLM 单一 cap 覆盖转写 + 描述，由全能 prompt 驱动
      processors.push(wrapLLMAsProcessor(entry, 'audio', { ...defaults, ...audioOverride }));
    }
    if (caps.includes(LLMCapabilities.Video)) {
      processors.push(wrapLLMAsProcessor(entry, 'video.passthrough', { ...defaults, ...videoOverride }));
    }
  }
  return processors;
}
