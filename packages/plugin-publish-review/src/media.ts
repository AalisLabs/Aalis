import { dirname, join } from 'node:path';
import type { CodeSandboxService } from '@aalis/api-code-sandbox';
import type { StorageService } from '@aalis/api-storage';
import { ITEM_ROOT } from './state.js';
import { stripStaticMedia } from './strip/index.js';

const asBytes = (value: string | Buffer): Uint8Array =>
  new Uint8Array(typeof value === 'string' ? Buffer.from(value) : value);
const ffprobeName = (ffmpeg: string) => join(dirname(ffmpeg), 'ffprobe');

/** Only fixed container fields may remain after a remux. Stream metadata is not needed for publication. */
export function inspectMp4Probe(value: unknown): { audio: boolean } {
  if (!value || typeof value !== 'object') throw new Error('视频核对失败');
  const probe = value as { streams?: unknown; format?: { tags?: unknown } };
  if (!Array.isArray(probe.streams) || !probe.format || typeof probe.format !== 'object')
    throw new Error('视频核对失败');
  const kinds = probe.streams.map(stream =>
    stream && typeof stream === 'object' ? (stream as { codec_type?: unknown }).codec_type : undefined,
  );
  if (
    kinds.filter(kind => kind === 'video').length !== 1 ||
    kinds.filter(kind => kind === 'audio').length > 1 ||
    kinds.some(kind => kind !== 'video' && kind !== 'audio')
  )
    throw new Error('视频包含不允许的轨道');
  const allowedFormat = new Set(['major_brand', 'minor_version', 'compatible_brands']);
  const tags = probe.format.tags ?? {};
  if (
    !tags ||
    typeof tags !== 'object' ||
    Array.isArray(tags) ||
    Object.keys(tags).some(key => !allowedFormat.has(key))
  )
    throw new Error('视频元数据未剥净');
  const formatTags = tags as Record<string, unknown>;
  if (
    formatTags.major_brand !== undefined &&
    !['isom', 'iso2', 'mp41', 'mp42'].includes(String(formatTags.major_brand))
  )
    throw new Error('视频元数据未剥净');
  if (formatTags.minor_version !== undefined && !/^\d{1,10}$/.test(String(formatTags.minor_version)))
    throw new Error('视频元数据未剥净');
  if (
    formatTags.compatible_brands !== undefined &&
    !/^(?:isom|iso2|avc1|mp41|mp42|iso6|dash){1,8}$/.test(String(formatTags.compatible_brands))
  )
    throw new Error('视频元数据未剥净');
  for (const stream of probe.streams) {
    const item = stream as { tags?: unknown };
    if (!item.tags) continue;
    if (typeof item.tags !== 'object' || Array.isArray(item.tags)) throw new Error('视频元数据未剥净');
    // ffmpeg writes these fixed MP4 fields; reject any other field rather than publishing a user tag.
    const streamTags = item.tags as Record<string, unknown>;
    if (Object.keys(streamTags).some(key => !['language', 'handler_name', 'vendor_id'].includes(key)))
      throw new Error('视频元数据未剥净');
    if (streamTags.handler_name && !['VideoHandler', 'SoundHandler'].includes(String(streamTags.handler_name)))
      throw new Error('视频元数据未剥净');
    if (streamTags.language && streamTags.language !== 'und') throw new Error('视频元数据未剥净');
    if (streamTags.vendor_id && streamTags.vendor_id !== '[0][0][0][0]') throw new Error('视频元数据未剥净');
  }
  return { audio: kinds.includes('audio') };
}

export class SandboxedMedia {
  readonly #storage: StorageService;
  readonly #sandbox: CodeSandboxService | undefined;
  readonly #ffmpeg: string;
  readonly #ffprobe: string;
  readonly #id: string;
  readonly #signal: AbortSignal;
  readonly #runId = Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex');
  #sequence = 0;

  constructor(input: {
    storage: StorageService;
    sandbox?: CodeSandboxService;
    ffmpegPath: string;
    ffprobePath?: string;
    id: string;
    signal: AbortSignal;
  }) {
    this.#storage = input.storage;
    this.#sandbox = input.sandbox;
    this.#ffmpeg = input.ffmpegPath;
    this.#ffprobe = input.ffprobePath ?? ffprobeName(input.ffmpegPath);
    this.#id = input.id;
    this.#signal = input.signal;
  }

  get available(): boolean {
    return !!this.#sandbox?.available && !!this.#storage.resolveLocalPath;
  }

  async #paths(
    bytes: Uint8Array,
    ext: string,
    resultExt = ext === 'mp4' ? 'mp4' : 'png',
  ): Promise<{ input: string; output: string; outputUri: string; dir: string; outUri: string }> {
    if (!this.available || !this.#storage.resolveLocalPath) throw new Error('本机暂时不能处理媒体');
    const root = `${ITEM_ROOT}/${this.#id}/work/${this.#runId}`;
    const inUri = `${root}/in`;
    const outUri = `${root}/out`;
    await this.#storage.mkdir(inUri);
    await this.#storage.mkdir(outUri);
    const n = ++this.#sequence;
    const inputUri = `${inUri}/input-${n}.${ext}`;
    const outputUri = `${outUri}/output-${n}.${resultExt}`;
    await this.#storage.writeFile(inputUri, Buffer.from(bytes));
    return {
      input: await this.#storage.resolveLocalPath(inputUri, 'read'),
      output: await this.#storage.resolveLocalPath(outputUri, 'write'),
      outputUri,
      dir: await this.#storage.resolveLocalPath(outUri, 'write'),
      outUri,
    };
  }

  async #runDetailed(cmd: string, args: string[], dir: string): Promise<{ stdout: string; stderr: string }> {
    if (!this.#sandbox?.available) throw new Error('本机暂时不能处理媒体');
    const result = await this.#sandbox.run({
      cmd,
      args,
      cwd: dir,
      timeout: 180_000,
      signal: this.#signal,
      policy: { fsRead: [dir], fsWrite: [dir], network: 'deny' },
    });
    if (result.code !== 0 || result.truncated) throw new Error('本机媒体处理失败');
    return { stdout: result.stdout, stderr: result.stderr };
  }

  async #run(cmd: string, args: string[], dir: string): Promise<string> {
    return (await this.#runDetailed(cmd, args, dir)).stdout;
  }

  async #decodedFrameCount(input: string, format: 'gif' | 'mp4', dir: string): Promise<number> {
    const raw = await this.#run(
      this.#ffprobe,
      [
        '-protocol_whitelist',
        'file',
        '-f',
        format,
        '-select_streams',
        'v:0',
        '-count_frames',
        '-show_entries',
        'stream=nb_read_frames',
        '-of',
        'json',
        input,
      ],
      dir,
    );
    const parsed: unknown = JSON.parse(raw);
    const streams = parsed && typeof parsed === 'object' ? (parsed as { streams?: unknown }).streams : undefined;
    const value =
      Array.isArray(streams) && streams.length === 1 && streams[0] && typeof streams[0] === 'object'
        ? (streams[0] as { nb_read_frames?: unknown }).nb_read_frames
        : undefined;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw new Error('抽帧帧数无法核对');
    const count = Number(value);
    if (!Number.isSafeInteger(count)) throw new Error('抽帧帧数无法核对');
    return count;
  }

  #actualDecodedFrames(stderr: string): number {
    const lines = stderr.split(/\r?\n/);
    let count = 0;
    for (const line of lines) {
      const match = /^\[Parsed_showinfo_\d+ @ [^\]]+\] n:\s*(\d+)\b/.exec(line);
      if (!match) continue;
      if (Number(match[1]) !== count) throw new Error('抽帧帧数无法核对');
      count++;
    }
    if (count === 0) throw new Error('抽帧帧数无法核对');
    return count;
  }

  /** Remux with a video and optional audio only; verify streams and remaining metadata before use. */
  async stripMp4(bytes: Uint8Array): Promise<{ bytes: Uint8Array; audio: boolean }> {
    const p = await this.#paths(bytes, 'mp4');
    await this.#run(
      this.#ffmpeg,
      [
        '-nostdin',
        '-protocol_whitelist',
        'file',
        '-f',
        'mp4',
        '-i',
        p.input,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-dn',
        '-sn',
        '-map_metadata',
        '-1',
        '-map_chapters',
        '-1',
        '-c',
        'copy',
        '-fflags',
        '+bitexact',
        '-flags:v',
        '+bitexact',
        '-flags:a',
        '+bitexact',
        p.output,
      ],
      p.dir,
    );
    const raw = await this.#run(
      this.#ffprobe,
      ['-protocol_whitelist', 'file', '-f', 'mp4', '-show_format', '-show_streams', '-of', 'json', p.output],
      p.dir,
    );
    const check = inspectMp4Probe(JSON.parse(raw));
    return { bytes: asBytes(await this.#storage.readFile(p.outputUri)), audio: check.audio };
  }

  /** Convert one static bitmap to a bounded, metadata-stripped PNG for classification. */
  async toPng(bytes: Uint8Array, ext: string, width = 1280): Promise<Uint8Array> {
    const format: Record<string, string> = {
      png: 'png_pipe',
      jpg: 'image2pipe',
      jpeg: 'image2pipe',
      webp: 'webp_pipe',
      gif: 'gif',
    };
    if (!format[ext]) throw new Error('图片格式不支持转换');
    const p = await this.#paths(bytes, ext);
    await this.#run(
      this.#ffmpeg,
      [
        '-nostdin',
        '-protocol_whitelist',
        'file',
        '-f',
        format[ext],
        '-i',
        p.input,
        '-frames:v',
        '1',
        '-vf',
        `scale='min(${width},iw)':'min(${width},ih)':force_original_aspect_ratio=decrease`,
        '-map_metadata',
        '-1',
        '-f',
        'image2',
        p.output,
      ],
      p.dir,
    );
    return stripStaticMedia('png', asBytes(await this.#storage.readFile(p.outputUri)));
  }

  async frameAt(bytes: Uint8Array, ext: 'mp4' | 'gif', second: number, width = 480): Promise<Uint8Array> {
    const p = await this.#paths(bytes, ext, 'png');
    await this.#run(
      this.#ffmpeg,
      [
        '-nostdin',
        '-protocol_whitelist',
        'file',
        '-f',
        ext,
        '-i',
        p.input,
        '-ss',
        String(second),
        '-frames:v',
        '1',
        '-vf',
        `scale='min(${width},iw)':'min(${width},ih)':force_original_aspect_ratio=decrease`,
        '-map_metadata',
        '-1',
        '-f',
        'image2',
        p.output,
      ],
      p.dir,
    );
    return stripStaticMedia('png', asBytes(await this.#storage.readFile(p.outputUri)));
  }

  /** Extract every unique GIF frame or periodic plus scene-change MP4 frames, capped at 37 to detect overflow. */
  async extractFrames(
    bytes: Uint8Array,
    ext: 'gif' | 'mp4',
    offset = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32,
  ): Promise<{ frames: Uint8Array[]; overflow: boolean }> {
    const p = await this.#paths(bytes, ext);
    const format = ext === 'gif' ? 'gif' : 'mp4';
    const sourceFrameCount = await this.#decodedFrameCount(p.input, format, p.dir);
    const filters =
      ext === 'gif'
        ? ['showinfo,mpdecimate=hi=0:lo=0:frac=0,scale=384:384:force_original_aspect_ratio=decrease,settb=AVTB']
        : [
            `showinfo,fps=1:start_time=${Math.min(0.999, Math.max(0, offset)).toFixed(3)},mpdecimate=hi=0:lo=0:frac=0,scale=384:384:force_original_aspect_ratio=decrease,settb=AVTB`,
            'showinfo,select=gt(scene\\,0.3),mpdecimate=hi=0:lo=0:frac=0,scale=384:384:force_original_aspect_ratio=decrease,settb=AVTB',
          ];
    const all: Array<{ time: number; frame: Uint8Array }> = [];
    const seen = new Set<string>();
    let overflow = false;
    for (const [pass, filter] of filters.entries()) {
      const dirUri = `${p.outUri}/frames-${this.#sequence}-${pass}`;
      await this.#storage.mkdir(dirUri);
      const path = await this.#storage.resolveLocalPath!(dirUri, 'write');
      const result = await this.#runDetailed(
        this.#ffmpeg,
        [
          '-nostdin',
          '-loglevel',
          'info',
          '-protocol_whitelist',
          'file',
          '-f',
          format,
          '-i',
          p.input,
          '-vf',
          filter,
          '-frames:v',
          '37',
          '-vsync',
          '0',
          '-frame_pts',
          '1',
          '-map_metadata',
          '-1',
          '-f',
          'image2',
          join(path, 'frame-%012d.png'),
        ],
        p.dir,
      );
      const entries = (await this.#storage.list(dirUri)).entries
        .filter(item => /^frame-\d{12}\.png$/.test(item.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (entries.length >= 37) overflow = true;
      const decoded = this.#actualDecodedFrames(result.stderr);
      if (entries.length < 37 && decoded !== sourceFrameCount) throw new Error('抽帧帧数不符');
      for (const entry of entries) {
        const frame = stripStaticMedia('png', asBytes(await this.#storage.readFile(entry.uri)));
        const digest = Buffer.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(frame))),
        ).toString('hex');
        if (seen.has(digest)) continue;
        seen.add(digest);
        all.push({ time: Number(entry.name.slice(6, 18)), frame });
      }
    }
    if (all.length === 0) throw new Error('抽帧没有产生图像');
    all.sort((a, b) => a.time - b.time);
    return { frames: all.slice(0, 36).map(item => item.frame), overflow: overflow || all.length > 36 };
  }

  async contactSheets(frames: readonly Uint8Array[]): Promise<Uint8Array[]> {
    if (!frames.length) throw new Error('没有动画帧');
    const p = await this.#paths(frames[0], 'png');
    const sheets: Uint8Array[] = [];
    for (let start = 0; start < Math.min(frames.length, 36); start += 9) {
      const dirUri = `${p.outUri}/sheet-${this.#sequence}-${start}`;
      await this.#storage.mkdir(dirUri);
      const dir = await this.#storage.resolveLocalPath!(dirUri, 'write');
      for (const [i, frame] of frames.slice(start, start + 9).entries())
        await this.#storage.writeFile(`${dirUri}/frame-${String(i + 1).padStart(3, '0')}.png`, Buffer.from(frame));
      const resultUri = `${p.outUri}/sheet-${this.#sequence}-${start}.png`;
      const resultPath = await this.#storage.resolveLocalPath!(resultUri, 'write');
      await this.#run(
        this.#ffmpeg,
        [
          '-nostdin',
          '-protocol_whitelist',
          'file',
          '-f',
          'image2',
          '-start_number',
          '1',
          '-i',
          join(dir, 'frame-%03d.png'),
          '-vf',
          'tile=3x3',
          '-frames:v',
          '1',
          '-map_metadata',
          '-1',
          '-f',
          'image2',
          resultPath,
        ],
        p.dir,
      );
      sheets.push(stripStaticMedia('png', asBytes(await this.#storage.readFile(resultUri))));
    }
    return sheets;
  }
}
