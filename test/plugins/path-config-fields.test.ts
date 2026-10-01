import { describe, expect, it } from 'vitest';
import whisper from '../../packages/plugin-asr-whisper-cpp/src/index.js';
import { configSchema as reviewSchema } from '../../packages/plugin-publish-review/src/config.js';
import { type ConfigSchema, parseConfig } from '../../packages/schema-config/src/index.js';

// ════════════════════════════════════════════════════════════
// 可执行文件字段留空时用默认的命令名：留空不能变成拿空串去执行（execFile('') 失败，审核视频处理整段失败）；
// 写成相对路径时拒绝激活，不按宿主进程的 cwd 去解析。
// ════════════════════════════════════════════════════════════

const quiet = { warn() {}, info() {}, debug() {}, error() {}, child: () => quiet } as never;

describe('路径类配置字段', () => {
  it('whisper-cli 路径留空用默认命令名，相对路径拒绝', () => {
    const schema = whisper.configSchema as ConfigSchema;
    expect(parseConfig(schema, { binaryPath: '', modelPath: '/m/x.bin' }, quiet).binaryPath).toBe('whisper-cli');
    expect(() => parseConfig(schema, { binaryPath: 'bin/whisper', modelPath: '/m/x.bin' }, quiet)).toThrow(
      'binaryPath 须为绝对路径或命令名',
    );
    expect(() => parseConfig(schema, { modelPath: 'models/x.bin' }, quiet)).toThrow('modelPath 须为绝对路径');
  });

  it('审核的 ffmpeg 路径留空用默认命令名，相对路径拒绝', () => {
    expect(parseConfig(reviewSchema, { ffmpegPath: '' }, quiet).ffmpegPath).toBe('ffmpeg');
    expect(() => parseConfig(reviewSchema, { ffmpegPath: './ffmpeg' }, quiet)).toThrow(
      'ffmpegPath 须为绝对路径或命令名',
    );
    expect(() => parseConfig(reviewSchema, { chrome: { executablePath: 'chrome' } }, quiet)).toThrow(
      'chrome.executablePath 须为绝对路径',
    );
  });
});
