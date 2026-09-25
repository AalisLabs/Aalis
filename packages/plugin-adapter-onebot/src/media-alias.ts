import type { MediaService } from '@aalis/api-media';

// ============================================================
// 描述缓存别名（原始 URL → 落盘 ref）的登记与查询。
//
// QQ 媒体直链不含内容哈希，落盘后才有内容寻址路径；引用消息那条路径手里只有原始 URL，
// 不登记别名就查不到刚识别出的描述、白重认一遍。直链里的 rkey 是访问密钥，定期轮换但
// 不改变文件：get_msg 反查拿到的是换过 rkey 的另一条串，按完整串相等就永远不命中。
// 登记时同时登记剥掉 rkey 的键，查询时也按剥掉 rkey 的键再查一次。
// ============================================================

/** 剥掉 URL query 里的 rkey（QQ 媒体直链的访问密钥，轮换不改变文件）；无 rkey 或不是合法 URL 原样返回。 */
export function stripRkey(url: string): string {
  try {
    const u = new URL(url);
    if (!u.searchParams.has('rkey')) return url;
    u.searchParams.delete('rkey');
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * 附件落盘成功后登记「原始来源 → 落盘 ref」别名：原始 URL 一条，剥 rkey 后的键若不同再一条。
 * media 未装即跳过。
 *
 * 只登记 http(s) 来源：base64 data URI 做键会把整段（可达数 MB）钉进别名表，而那条路径由
 * plugin-media 自己在落盘处登记。音频走转写、不进描述缓存，登记只会白占别名表一格。
 */
export function rememberLandedAlias(
  media: MediaService | undefined,
  kind: string,
  source: string | undefined,
  landedRef: string,
): void {
  if (!media || kind === 'audio' || !source || !/^https?:\/\//.test(source)) return;
  media.rememberDescriptionAlias(source, landedRef);
  const stripped = stripRkey(source);
  if (stripped !== source) media.rememberDescriptionAlias(stripped, landedRef);
}

/** 按原始 URL 查描述：先原串，再剥 rkey 后的键（rkey 轮换后 get_msg 给的是另一条串）。 */
export function lookupDescriptionByUrl(media: MediaService, url: string): string | null {
  const direct = media.lookupDescription(url);
  if (direct) return direct;
  const stripped = stripRkey(url);
  return stripped !== url ? media.lookupDescription(stripped) : null;
}
