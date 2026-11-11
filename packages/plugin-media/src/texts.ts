// 本插件自己的原文字典：显示名与配置项（内置的提示词作参数原样放），诊断项「识图」的说明（识别模型的显示名作参数），/clear 的
// 类型显示名与清理上传的图片、描述缓存的回执，识别模型在长度上限处停下时描述与转写末尾的标记
import { defineTexts } from '@aalis/schema-i18n';
import en from './locales/en.js';

const SOURCE = {
  displayName: '多模态媒体识别',
  visionLabel: '图像识别',
  visionPreferLabel: '识别模型',
  visionPreferDescription: '把图片转成文字描述的模型。留空则自动选择优先级最高的能看图的模型。',
  recognizeOnArrivalLabel: '接触到图片立即识别',
  recognizeOnArrivalDescription:
    '开启时图片一到就识别，描述写进历史，可被记忆检索到；关闭时只存图片引用，主模型需要时再查看，图片内容检索不到。',
  deliveryLabel: '主模型看图方式',
  deliveryAuto: '自动：主模型有 vision 能力则直通原图，否则交给识别模型转文字',
  deliveryPassthrough: '直通：原图交给主模型（动图抽帧为多张静图；需主模型 vision 能力）',
  deliveryDescribe: '转文字：始终由识别模型描述，主模型只读文字',
  deliveryDescription: '决定当轮附件与 analyze_image 的交付形态。',
  visionMaxTokensLabel: '描述最大 token',
  visionMaxTokensDescription: '只防失控，模型因上限停下时在描述末尾标出。须为正整数，否则实例转为出错',
  thinkLabel: '启用思考链',
  visionThinkDescription:
    '开启时用模型的默认思考档，识别可能更准但更耗 token；关闭时用最浅的一档。模型不能调思考时无效。',
  visionPromptLabel: '单图描述 prompt',
  visionPromptDescription:
    '填写后替换 auto 与 casual 档的描述 prompt，detailed 与 professional 档仍用内置模板。留空时用内置 prompt。\n内置简洁模板供参考：{prompt}',
  batchPromptLabel: '多图批量描述 prompt',
  batchPromptDescription:
    '多张图片一起描述时使用（动图抽帧 / 图组）。留空则回落到「单图描述 prompt」或内置默认。\n默认：{prompt}',
  audioLabel: '音频识别',
  modeLabel: '模式',
  audioEnabled: '启用（转写后注入上下文）',
  audioPassthrough: '直通：原始音频交给主模型（需主模型有 audio 能力）',
  disabled: '禁用',
  audioPreferLabel: '处理后端',
  audioPreferAuto: '自动（按优先级）',
  audioPreferDescription:
    'Whisper/ASR 与「能识别音频的模型」合在一个下拉里选；留空=按优先级自动。可选项随已装后端变化。',
  audioLanguageLabel: '默认语种 (ISO 639-1)',
  audioLanguageDescription: '仅对 Whisper 类 ASR 生效；能识别音频的模型会在 prompt 里作为提示。',
  audioMaxTokensLabel: '最大输出 token',
  audioMaxTokensDescription:
    '只对能识别音频的模型生效，用来防止输出失控，思考与正文共用。因上限停下时在转写末尾标出；须为正整数，否则实例转为出错。',
  audioThinkDescription:
    '只对能识别音频的模型生效。开启时用模型的默认思考档，识别更准，但 token 消耗约为 5 到 8 倍；关闭时用最浅的一档。模型不能调思考时无效。',
  audioPromptLabel: '自定义 prompt',
  audioPromptDescription: '只对能识别音频的模型生效。留空使用内置全能描述 prompt。\n默认：{prompt}',
  videoLabel: '视频识别',
  videoFramesAsr: '关键帧 + 音轨转写',
  videoFramesOnly: '仅关键帧',
  maxFramesLabel: '最大关键帧数',
  framesHintLabel: '抽帧描述提示语',
  framesHintDescription:
    '抽帧后拼帧交给能看图的模型时的提示语。留空使用默认：“以下为同一视频的关键帧，按时间顺序排列。”',
  animatedPromptLabel: '动图/短视频描述 prompt',
  animatedPromptDescription: '描述动图时用的整段 prompt，替换内置的多图批量模板；留空用内置模板。',
  framePrefixLabel: '画面描述前缀',
  framePrefixDescription: '拼到抽帧综合描述前的标记，例如 “[画面] …”。',
  audioTrackPrefixLabel: '音轨转写前缀',
  audioTrackPrefixDescription: '拼到视频音轨转写前的标记，例如 “[音轨] …”。',
  animatedImageLabel: '动图 / GIF',
  animatedMaxFramesDescription: '动图（GIF、动态 WebP 等）最多抽几帧，与视频的帧数上限分开设。调高会增加识图开销。',
  contextHistoryLabel: '多模态上下文注入',
  contextHistoryEnabledLabel: '允许媒体识别读取聊天上下文',
  contextHistoryEnabledDescription:
    '开启后，识别图片、音频与视频时把近期聊天记录一并交给模型，让它联系上下文识别。对 Whisper 类语音识别后端无效。',
  contextHistoryMaxMessagesLabel: '上下文最大消息条数',
  senderContextLabel: '发送者画像注入',
  senderContextEnabledLabel: '允许在识图时注入发送者的用户画像摘要',
  senderContextEnabledDescription:
    '开启后，识别图片时带上发送者的用户画像摘要，帮助模型理解图片的用意。读不到画像时跳过，不影响识别。',
  profileMaxCharsLabel: '画像摘要最大字符数',
  profileMaxCharsDescription: '超过截断。填 0 等于禁用画像注入。',
  visionUnavailable: '装了识图插件，但没有能看图的识别模型：图片照样存下，主模型看不到内容',
  visionUnavailableFix:
    '在模型服务里加一个能看图的模型，再到「多模态媒体识别」的「图像识别 → 识别模型」里选它（留空则自动选用）',
  snapshotUnreadable: '内存中已删除 {count, number} 条，但本次运行未能读取描述快照，磁盘上的快照未改写，重启后会恢复',
  visionReady: '识图可用，识别模型：{model}',
  clearTypeImage: '图片缓存',
  clearTypeVideo: '视频缓存',
  uploadsCleared: '上传的图片已清空（{count, number} 个）',
  uploadsFailed: '上传的图片清空失败：{error}',
  kindImage: '图片',
  kindVideo: '视频',
  descriptionsClearedAll: '所有{kind}描述缓存已清空（{count, number} 条）',
  descriptionsClearedSession: '当前会话{kind}描述缓存已清空（{count, number} 条）',
  descriptionsFailed: '{kind}描述缓存清空失败：{error}',
  cutOff: '{text}（已在长度上限处截断）',
  processorLabel: '{label} ({cap})',
  asrLabel: 'Whisper/ASR · {label}',
} as const;
export type Source = typeof SOURCE;

export const t = defineTexts({ ns: '@aalis/plugin-media', language: 'zh-CN', source: SOURCE, locales: { en } });
