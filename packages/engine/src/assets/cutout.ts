import type { RgbaImage } from '@auto-adv/providers';

/**
 * 立绘的内置抠图和透明度检查（18.5）。不依赖任何库，只处理纯色底的图：
 * 从图像四边往里找连着的、接近底色的区域，再把被人物围起来的大块底色（胳膊和身子之间）也去掉；
 * 边缘一圈按和底色的差别做半透明，顺带去掉底色渗进来的色边。
 */

export interface KeyOptions {
  /** 和底色差多少以内算背景（RGB 各通道差的最大值）。默认 48。 */
  tolerance?: number;
}

const idx = (img: RgbaImage, x: number, y: number) => (y * img.width + x) * 4;

/** 四边（底边除外：膝上半身的人物会碰到底边）的像素。 */
function borderPixels(img: RgbaImage): number[] {
  const { width: w, height: h } = img;
  const out: number[] = [];
  for (let x = 0; x < w; x++) out.push(idx(img, x, 0));
  for (let y = 1; y < h; y++) out.push(idx(img, 0, y), idx(img, w - 1, y));
  return out;
}

/** 估计底色：四边像素每个通道的中位数（底色略微偏灰、偏黄也能认出来）。 */
export function estimateBackdrop(img: RgbaImage): [number, number, number] {
  const px = borderPixels(img);
  const median = (c: number) => {
    const v = px.map((i) => img.data[i + c] as number).sort((a, b) => a - b);
    return v[v.length >> 1] ?? 255;
  };
  return [median(0), median(1), median(2)];
}

/** 图本身带不带透明背景：四边（不算底边）一半以上的像素是透明的。 */
export function hasTransparentBackdrop(img: RgbaImage): boolean {
  const px = borderPixels(img);
  return px.filter((i) => (img.data[i + 3] as number) < 16).length > px.length / 2;
}

/** 纯色底抠图，返回新的图（原图不变）。 */
export function keyOut(img: RgbaImage, opts: KeyOptions = {}): RgbaImage {
  const { width: w, height: h } = img;
  const src = img.data;
  const data = new Uint8Array(src);
  const n = w * h;
  const tol = opts.tolerance ?? 48;
  const [br, bg, bb] = estimateBackdrop(img);
  const dist = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    dist[p] = Math.max(Math.abs((src[i] as number) - br), Math.abs((src[i + 1] as number) - bg), Math.abs((src[i + 2] as number) - bb));
  }

  // 1. 从四边往里漫，连着的、接近底色的都是背景
  const back = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const seed = (p: number) => {
    if (!back[p] && (dist[p] as number) < tol) {
      back[p] = 1;
      queue[tail++] = p;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (head < tail) {
    const p = queue[head++] as number;
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) seed(p - 1);
    if (x < w - 1) seed(p + 1);
    if (y > 0) seed(p - w);
    if (y < h - 1) seed(p + w);
  }

  // 2. 被人物围起来的、几乎就是底色的大块区域也是背景（小块的可能是高光，留着）
  const tight = Math.min(tol, 20);
  const minArea = Math.max(16, Math.round(n * 0.0015));
  const seen = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    if (back[s] || seen[s] || (dist[s] as number) >= tight) continue;
    head = 0;
    tail = 0;
    seen[s] = 1;
    queue[tail++] = s;
    while (head < tail) {
      const p = queue[head++] as number;
      const x = p % w;
      const y = (p - x) / w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && !seen[q] && !back[q] && (dist[q] as number) < tight) {
          seen[q] = 1;
          queue[tail++] = q;
        }
      }
    }
    if (tail >= minArea) for (let k = 0; k < tail; k++) back[queue[k] as number] = 1;
  }

  // 3. 背景全透明；挨着背景的一圈按和底色的差别做半透明，并去掉底色渗进来的颜色
  const lo = 8;
  const hi = Math.max(lo + 1, tol * 2);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (back[p]) {
      data[i + 3] = 0;
      continue;
    }
    const x = p % w;
    const y = (p - x) / w;
    const edge = (x > 0 && back[p - 1]) || (x < w - 1 && back[p + 1]) || (y > 0 && back[p - w]) || (y < h - 1 && back[p + w]);
    if (!edge) continue;
    const a = Math.min(1, Math.max(0, ((dist[p] as number) - lo) / (hi - lo)));
    if (a <= 0) {
      data[i + 3] = 0;
      continue;
    }
    const un = (c: number, b: number) => Math.round(Math.min(255, Math.max(0, (c - (1 - a) * b) / a)));
    data[i] = un(src[i] as number, br);
    data[i + 1] = un(src[i + 1] as number, bg);
    data[i + 2] = un(src[i + 2] as number, bb);
    data[i + 3] = Math.round((src[i + 3] as number) * a);
  }
  return { width: w, height: h, data };
}

export interface AlphaCheck {
  ok: boolean;
  /** 不合格的原因（给人看）。 */
  reason: string | null;
  /** 人物占画面的比例。 */
  coverage: number;
}

/**
 * 抠完检查透明度（18.5）：人物占画面的比例、四边有没有残留、有没有大块透明的洞。
 * holes：要不要查洞。内置抠图会故意去掉被人物围起来的底色，所以只对服务给的透明图查。
 */
export function checkAlpha(img: RgbaImage, opts: { holes?: boolean } = {}): AlphaCheck {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const solid = (p: number) => (data[p * 4 + 3] as number) >= 128;
  let opaque = 0;
  for (let p = 0; p < n; p++) if (solid(p)) opaque++;
  const coverage = opaque / n;
  const fail = (reason: string): AlphaCheck => ({ ok: false, reason, coverage });
  if (coverage < 0.04) return fail('人物几乎全被抠掉了');
  if (coverage > 0.9) return fail('背景没有抠掉');

  let top = 0;
  for (let x = 0; x < w; x++) if (solid(x)) top++;
  // 左右两边只看上面 85%（膝上半身的人物下面可能挨着边）
  const sideH = Math.max(1, Math.floor(h * 0.85));
  let sides = 0;
  for (let y = 0; y < sideH; y++) {
    if (solid(y * w)) sides++;
    if (solid(y * w + w - 1)) sides++;
  }
  if (top / w > 0.05 || sides / (sideH * 2) > 0.2) return fail('四边有没抠干净的背景');

  if (opts.holes) {
    // 从四边漫进来的透明区域之外，还有大块透明：人物身上被抠出了洞
    const outside = new Uint8Array(n);
    const queue = new Int32Array(n);
    let head = 0;
    let tail = 0;
    const seed = (p: number) => {
      if (!outside[p] && !solid(p)) {
        outside[p] = 1;
        queue[tail++] = p;
      }
    };
    for (let x = 0; x < w; x++) {
      seed(x);
      seed((h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
      seed(y * w);
      seed(y * w + w - 1);
    }
    while (head < tail) {
      const p = queue[head++] as number;
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0) seed(p - 1);
      if (x < w - 1) seed(p + 1);
      if (y > 0) seed(p - w);
      if (y < h - 1) seed(p + w);
    }
    let holes = 0;
    for (let p = 0; p < n; p++) if (!solid(p) && !outside[p]) holes++;
    if (holes > opaque * 0.03) return fail('人物身上有大块透明的洞');
  }
  return { ok: true, reason: null, coverage };
}
