import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Multimodal media recognition',
  visionLabel: 'Image recognition',
  visionPreferLabel: 'Recognition model',
  visionPreferDescription:
    'The model that turns images into text descriptions. Empty = automatically pick the image-capable model with the highest priority.',
  recognizeOnArrivalLabel: 'Recognize images on arrival',
  recognizeOnArrivalDescription:
    'On: images are recognized as they arrive, and the descriptions go into the history where memory search can find them. Off: only image references are kept and the main model looks when it needs to; image contents cannot be found by search.',
  deliveryLabel: 'How the main model sees images',
  deliveryAuto:
    'Auto: pass the original image through when the main model has vision, otherwise hand it to the recognition model to turn into text',
  deliveryPassthrough:
    'Pass through: the original image goes to the main model (animated images are split into stills; needs vision on the main model)',
  deliveryDescribe: 'To text: always described by the recognition model; the main model only reads the text',
  deliveryDescription: "Decides how this turn's attachments and analyze_image results are delivered.",
  visionMaxTokensLabel: 'Max description tokens',
  visionMaxTokensDescription:
    'Only guards against runaway output; when the model stops at the limit, the end of the description says so. Must be a positive integer, otherwise the instance goes into error',
  thinkLabel: 'Enable thinking',
  visionThinkDescription:
    "When on, uses the model's default thinking level, which may improve recognition but costs more tokens; when off, uses the lightest level. No effect when the model cannot adjust thinking.",
  visionPromptLabel: 'Single-image description prompt',
  visionPromptDescription:
    'When filled in, replaces the description prompt of the auto and casual levels; the detailed and professional levels still use their built-in templates. When empty, the built-in prompts are used.\nThe built-in concise template, for reference: {prompt}',
  batchPromptLabel: 'Multi-image batch description prompt',
  batchPromptDescription:
    'Used when several images are described together (frames of an animated image / image sets). When empty, falls back to the “Single-image description prompt” or the built-in default.\nDefault: {prompt}',
  audioLabel: 'Audio recognition',
  modeLabel: 'Mode',
  audioEnabled: 'Enabled (inject into the context after transcribing)',
  audioPassthrough: 'Pass through: the original audio goes to the main model (needs audio on the main model)',
  disabled: 'Disabled',
  audioPreferLabel: 'Processing backend',
  audioPreferAuto: 'Auto (by priority)',
  audioPreferDescription:
    'Whisper/ASR and “models that can recognize audio” in one dropdown; empty = automatic by priority. The options change with the installed backends.',
  audioLanguageLabel: 'Default language (ISO 639-1)',
  audioLanguageDescription:
    'Only applies to Whisper-style ASR; models that recognize audio use it as a hint in the prompt.',
  audioMaxTokensLabel: 'Max output tokens',
  audioMaxTokensDescription:
    'Only for models that recognize audio; guards against runaway output, shared by thinking and the transcript. When the model stops at the limit, the end of the transcript says so; must be a positive integer, otherwise the instance goes into error.',
  audioThinkDescription:
    "Only for models that recognize audio. When on, uses the model's default thinking level, for better recognition at about 5 to 8 times the tokens; when off, uses the lightest level. No effect when the model cannot adjust thinking.",
  audioPromptLabel: 'Custom prompt',
  audioPromptDescription:
    'Only for models that recognize audio. When empty, the built-in all-round description prompt is used.\nDefault: {prompt}',
  videoLabel: 'Video recognition',
  videoFramesAsr: 'Key frames + audio track transcription',
  videoFramesOnly: 'Key frames only',
  maxFramesLabel: 'Max key frames',
  framesHintLabel: 'Frame description hint',
  framesHintDescription:
    'The hint sent with the stitched frames to the vision model. When empty, the default is used: “以下为同一视频的关键帧，按时间顺序排列。”',
  animatedPromptLabel: 'Animated image / short video description prompt',
  animatedPromptDescription:
    'The whole-clip prompt for describing animated images, replacing the built-in multi-image batch template; when empty, the built-in template is used.',
  framePrefixLabel: 'Frame description prefix',
  framePrefixDescription: 'The marker put before the combined frame description, such as “[画面] …”.',
  audioTrackPrefixLabel: 'Audio track transcript prefix',
  audioTrackPrefixDescription: "The marker put before the video's audio track transcript, such as “[音轨] …”.",
  animatedImageLabel: 'Animated images / GIF',
  animatedMaxFramesDescription:
    'How many frames to take from an animated image (animated GIF, WebP and so on), set separately from the video frame limit. Raising it increases the cost of image recognition.',
  contextHistoryLabel: 'Multimodal context injection',
  contextHistoryEnabledLabel: 'Let media recognition read the chat context',
  contextHistoryEnabledDescription:
    'When on, recent chat history goes to the model along with images, audio and video, so it can recognize them in context. No effect on Whisper-style speech recognition backends.',
  contextHistoryMaxMessagesLabel: 'Max context messages',
  senderContextLabel: 'Sender profile injection',
  senderContextEnabledLabel: "Allow injecting the sender's profile summary when recognizing images",
  senderContextEnabledDescription:
    "When on, image recognition includes the sender's user profile summary, helping the model understand what the image is for. Skipped when the profile cannot be read, without affecting recognition.",
  profileMaxCharsLabel: 'Max profile summary characters',
  profileMaxCharsDescription: 'Truncated beyond this. 0 disables profile injection.',
  visionUnavailable:
    'The image recognition plugin is installed, but no recognition model can see images: images are still saved, but the main model cannot see their content',
  visionUnavailableFix:
    'Add a model that can see images in the model services, then choose it under “Image recognition → Recognition model” in “Multimodal media recognition” (left empty, one is chosen automatically)',
  snapshotUnreadable:
    '{count, plural, one {# entry was} other {# entries were}} deleted from memory, but this run could not read the description snapshot, so the snapshot on disk was not rewritten and {count, plural, one {it} other {they}} will come back after a restart',
  visionReady: 'Image recognition is available; recognition model: {model}',
  clearTypeImage: 'Image cache',
  clearTypeVideo: 'Video cache',
  uploadsCleared: 'Cleared uploaded images ({count, plural, one {# file} other {# files}})',
  uploadsFailed: 'Failed to clear uploaded images: {error}',
  kindImage: 'image',
  kindVideo: 'video',
  descriptionsClearedAll: 'Cleared all {kind} description caches ({count, plural, one {# entry} other {# entries}})',
  descriptionsClearedSession:
    "Cleared this session's {kind} description cache ({count, plural, one {# entry} other {# entries}})",
  descriptionsFailed: 'Failed to clear the {kind} description cache: {error}',
  cutOff: '{text} (cut off at the length limit)',
  processorLabel: '{label} ({cap})',
  asrLabel: 'Whisper/ASR · {label}',
});
