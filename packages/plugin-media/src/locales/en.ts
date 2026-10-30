import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Multimodal media recognition',
  visionLabel: 'Image recognition',
  visionPreferLabel: 'Recognition model',
  visionPreferDescription:
    'The model that turns images into text descriptions. Empty = automatically pick the vision LLM with the highest priority.',
  recognizeOnArrivalLabel: 'Recognize images on arrival',
  recognizeOnArrivalDescription:
    'On: images are recognized as they arrive and the descriptions go into the archive and the vector store (so they can be recalled); messages that did not trigger a reply leave memories too. Off: the archive keeps only image pointers, and the main model looks at them on demand through analyze_image; image contents then cannot be searched or recalled.',
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
    "When on, uses the default thinking level configured in the model service, which may improve recognition but costs more tokens; when off, uses the model's lightest level (for Ollama, thinking off). No effect when the model cannot adjust thinking.",
  visionPromptLabel: 'Single-image description prompt',
  visionPromptDescription:
    'When filled in, fully replaces the description prompt of the auto level (self-routing) and the casual level; the detailed/professional levels still use their built-in templates. When empty, the auto level uses the built-in self-routing prompt (the model judges the kind of image and sets the detail accordingly), and the casual level uses the built-in concise template.\nThe built-in concise template, for reference: {prompt}',
  batchPromptLabel: 'Multi-image batch description prompt',
  batchPromptDescription:
    'Used when several images are described together (frames of an animated image / image sets). When empty, falls back to the “single-image prompt” or the built-in default.\nDefault: {prompt}',
  audioLabel: 'Audio recognition (transcription + description)',
  modeLabel: 'Mode',
  audioEnabled: 'Enabled (inject into the context after transcribing)',
  audioPassthrough: 'Pass through: the original audio goes to the main model (needs audio on the main model)',
  disabled: 'Disabled',
  audioPreferLabel: 'Processing backend',
  audioPreferAuto: 'Auto (by priority)',
  audioPreferDescription:
    'Whisper/ASR and “LLMs that can recognize audio” in one dropdown; empty = automatic by priority. The options change with the installed backends.',
  audioLanguageLabel: 'Default language (ISO 639-1)',
  audioLanguageDescription: 'Only applies to Whisper-style ASR; LLM-as-audio uses it as a hint in the prompt.',
  audioMaxTokensLabel: 'Max output tokens',
  audioMaxTokensDescription:
    'LLM-as-audio only. Only guards against runaway output; thinking and the transcript share this budget, and when the model stops at the limit, the end of the transcript says so. Must be a positive integer, otherwise the instance goes into error.',
  audioThinkDescription:
    "LLM-as-audio only. When on, uses the default thinking level configured in the model service, for better recognition at ×5-8 the token cost; when off, uses the model's lightest level (for Ollama, reasoning_effort=none). No effect when the model cannot adjust thinking.",
  audioPromptLabel: 'Custom prompt',
  audioPromptDescription:
    'LLM-as-audio only. When empty, the built-in all-round description prompt is used.\nDefault: {prompt}',
  videoLabel: 'Video recognition',
  videoFramesAsr: 'Key frames + audio track transcription',
  videoFramesOnly: 'Key frames only',
  maxFramesLabel: 'Max key frames',
  framesHintLabel: 'Frame description hint',
  framesHintDescription:
    'The hint sent with the stitched frames to the vision model. When empty, the default is used: “以下为同一视频的关键帧，按时间顺序排列。”',
  animatedPromptLabel: 'Animated image / short video description prompt',
  animatedPromptDescription:
    'The whole-clip description prompt `describeImage` uses for animated images (replacing the built-in multi-image batch template); when empty, the built-in multi-image batch template is used.',
  framePrefixLabel: 'Frame description prefix',
  framePrefixDescription: 'The marker put before the combined frame description, such as “[画面] …”.',
  audioTrackPrefixLabel: 'Audio track transcript prefix',
  audioTrackPrefixDescription: "The marker put before the video's audio track transcript, such as “[音轨] …”.",
  animatedImageLabel: 'Animated images / GIF',
  animatedMaxFramesDescription:
    "Frame limit for animated images (animated gif/webp and so on), separate from the video's video.maxFrames. Animated images carry little information, so the default 5 is enough; raising it increases the cost of vision calls.",
  contextHistoryLabel: 'Multimodal context injection',
  contextHistoryEnabledLabel: 'Let multimodal processors read the chat context',
  contextHistoryEnabledDescription:
    'When on, image description / audio recognition / video frame calls to multimodal models put recent chat history into the prompt, so the model can recognize things in context. No effect on traditional Whisper-style ASR backends.',
  contextHistoryMaxMessagesLabel: 'Max context messages',
  senderContextLabel: 'Sender profile injection (vision)',
  senderContextEnabledLabel: "Allow injecting the sender's user-profile summary into the vision context",
  senderContextEnabledDescription:
    "When on, vision includes the sender's long-term fact summary (from plugin-user-profile) when describing images, helping the model understand scenes like “a Minecraft screenshot = a player showing off”. When reading fails or user-profile is not enabled, it is skipped silently without blocking recognition.",
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
