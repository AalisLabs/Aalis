// ============================================================
// animation.ts — 逐帧定格：暂停两套动画时钟、探测时长、按帧步进
//
// 双机制必须并用（调研实测 getAnimations() 不暴露 SMIL）：
//   SMIL → svg.pauseAnimations() + svg.setCurrentTime(t)
//   CSS/WAAPI → document.getAnimations() 逐个 pause() + currentTime=t*1000
// 步进与截图之间没有真实时间依赖，帧序列逐字节确定（调研实测）。
// 页面禁用了脚本，这些脚本经 CDP 求值执行，不受影响。
// ============================================================

export interface AnimationOptions {
  fps: number;
  maxFrames: number;
  maxDurationMs: number;
  /** 调用方指定的时长；缺省时取文档声明的时长 */
  durationMs?: number;
  /** 没指定、也没探测到声明时长时用的时长；缺省为 0，即只出两帧 */
  defaultDurationMs?: number;
}

export interface FramesResult {
  frames: Uint8Array[];
  /** 实际覆盖的时长（帧数受 maxFrames 收口时按帧数反推） */
  durationMs: number;
  /** 探测到的动画数（SMIL 元素与 CSS/WAAPI 动画之和）；0 表示文档是静态的 */
  animationCount: number;
}

/**
 * 暂停两套时钟，顺带数动画数与声明时长：CSS 按 delay + duration × iterations，SMIL 按 getSimpleDuration，
 * 无限循环按单轮计。
 */
export const PAUSE_AND_PROBE = `(() => {
  let count = 0;
  let max = 0;
  for (const svg of document.querySelectorAll('svg')) {
    try { svg.pauseAnimations(); } catch {}
    for (const el of svg.querySelectorAll('animate,animateTransform,animateMotion,set')) {
      count += 1;
      try {
        const d = el.getSimpleDuration();
        if (Number.isFinite(d)) max = Math.max(max, d * 1000);
      } catch {}
    }
  }
  for (const a of document.getAnimations()) {
    try {
      a.pause();
      count += 1;
      const t = a.effect.getComputedTiming();
      const iters = Number.isFinite(t.iterations) ? t.iterations : 1;
      max = Math.max(max, (t.delay || 0) + (Number(t.duration) || 0) * iters);
    } catch {}
  }
  return { count, durationMs: Math.round(max) };
})()`;

/** 把两套时钟定格到第 t 秒 */
export function seekScript(t: number): string {
  return `((t) => {
  for (const svg of document.querySelectorAll('svg')) {
    try { svg.setCurrentTime(t); } catch {}
  }
  for (const a of document.getAnimations()) {
    try { a.pause(); a.currentTime = t * 1000; } catch {}
  }
})(${t.toFixed(6)})`;
}

/** 时长：指定 > 探测 > 缺省，受 maxDurationMs 收口；帧数至少 2，受 maxFrames 收口（超出按帧数反推时长）。 */
export function planFrames(probedMs: number, anim: AnimationOptions): { frameCount: number; durationMs: number } {
  if (!(anim.fps > 0)) throw new TypeError(`fps 必须大于 0：${anim.fps}`);
  let durationMs = anim.durationMs ?? (probedMs > 0 ? probedMs : (anim.defaultDurationMs ?? 0));
  durationMs = Math.min(durationMs, anim.maxDurationMs);
  let frameCount = Math.max(2, Math.round((durationMs / 1000) * anim.fps));
  if (frameCount > anim.maxFrames) {
    frameCount = anim.maxFrames;
    durationMs = Math.round((frameCount / anim.fps) * 1000);
  }
  return { frameCount, durationMs };
}
