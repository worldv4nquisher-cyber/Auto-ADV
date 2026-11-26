import type { RgbaImage } from '@auto-adv/providers';

/**
 * 立绘的内置抠图和透明度检查（18.5、19.2）。不依赖任何库，只处理纯色底的图：
 * 1. 从图像四边往里找连着的、接近底色的区域；
 * 2. 被人物围起来的底色也去掉：大块的（胳膊和身子之间），挨着人物轮廓的小块（发丝之间的空隙），
 *    纯绿这类鲜艳的底色不管大小都去掉（眼镜片后面透出来的底色）。离轮廓远的小块白色留着（眼白、高光）；
 * 3. 轮廓往里两圈按和底色的差别做半透明，再去掉底色渗进来的颜色（JPEG 的色度采样会让底色渗进去一两个像素）。
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

/** 每个像素离 mask 多远（四邻接，一圈一圈数），mask 里的是 0，最多数到 max，更远的记 255。 */
function rings(mask: Uint8Array, w: number, h: number, max: number): Uint8Array {
  const n = w * h;
  const d = new Uint8Array(n).fill(255);
  let frontier: number[] = [];
  for (let p = 0; p < n; p++) {
    if (mask[p]) {
      d[p] = 0;
      frontier.push(p);
    }
  }
  for (let r = 1; r <= max && frontier.length; r++) {
    const next: number[] = [];
    for (const p of frontier) {
      const x = p % w;
      const visit = (q: number) => {
        if (d[q] === 255) {
          d[q] = r;
          next.push(q);
        }
      };
      if (x > 0) visit(p - 1);
      if (x < w - 1) visit(p + 1);
      if (p >= w) visit(p - w);
      if (p < n - w) visit(p + w);
    }
    frontier = next;
  }
  return d;
}

/** 纯色底抠图，返回新的图（原图不变）。 */
export function keyOut(img: RgbaImage, opts: KeyOptions = {}): RgbaImage {
  const { width: w, height: h } = img;
  const src = img.data;
  const data = new Uint8Array(src);
  const n = w * h;
  const tol = opts.tolerance ?? 48;
  const backdrop = estimateBackdrop(img);
  const [br, bg, bb] = backdrop;
  // 鲜艳的底色（纯绿这类）：人物身上几乎不会有一样的颜色，围起来的小块也可以放心去掉
  const vivid = Math.max(br, bg, bb) - Math.min(br, bg, bb) >= 64;
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
    if (x > 0) seed(p - 1);
    if (x < w - 1) seed(p + 1);
    if (p >= w) seed(p - w);
    if (p < n - w) seed(p + w);
  }

  // 2. 被人物围起来的底色：大块的、挨着轮廓的、鲜艳底色的都去掉；离轮廓远的小块（眼白、高光）留着
  const NEAR = 10;
  const near = rings(back, w, h, NEAR);
  const limit = vivid ? tol : Math.min(tol, 20);
  const minArea = Math.max(16, Math.round(n * 0.0015));
  const seen = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    if (back[s] || seen[s] || (dist[s] as number) >= limit) continue;
    head = 0;
    tail = 0;
    seen[s] = 1;
    queue[tail++] = s;
    let touches = false;
    while (head < tail) {
      const p = queue[head++] as number;
      if ((near[p] as number) <= NEAR) touches = true;
      const x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p >= w ? p - w : -1, p < n - w ? p + w : -1]) {
        if (q >= 0 && !seen[q] && !back[q] && (dist[q] as number) < limit) {
          seen[q] = 1;
          queue[tail++] = q;
        }
      }
    }
    if (tail >= minArea || (tail >= 4 && (vivid || touches))) for (let k = 0; k < tail; k++) back[queue[k] as number] = 1;
  }

  // 3. 轮廓往里两圈做半透明：人物的颜色按轮廓往里第 3、4 圈的典型差别算（大多是勾线的深色），
  //    混了底色的像素按比例算透明度，再把底色减掉；鲜艳的底色再把轮廓往里 12 圈内渗进来的那个通道压下去
  //    （发丝之间透出来的底色常常带着阴影，比容差深，留在人物里面）
  const SPILL = 12;
  const ring = rings(back, w, h, SPILL);
  const hist = new Uint32Array(256);
  let inner = 0;
  for (let p = 0; p < n; p++) {
    if (ring[p] === 3 || ring[p] === 4) {
      hist[dist[p] as number] = (hist[dist[p] as number] as number) + 1;
      inner++;
    }
  }
  let solid = tol * 2;
  if (inner > 0) {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v] as number;
      if (acc * 2 >= inner) {
        solid = v;
        break;
      }
    }
  }
  const lo = 8;
  const hi = Math.min(255, Math.max(tol + 8, solid));
  const top = backdrop.indexOf(Math.max(br, bg, bb));
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (back[p]) {
      data[i + 3] = 0;
      continue;
    }
    const r = ring[p] as number;
    if (r > (vivid ? SPILL : 2)) continue;
    if (r <= 2) {
      const a = Math.min(1, Math.max(0, ((dist[p] as number) - lo) / (hi - lo)));
      if (a <= 0) {
        data[i + 3] = 0;
        continue;
      }
      if (a < 1) {
        for (let c = 0; c < 3; c++) {
          const v = ((src[i + c] as number) - (1 - a) * (backdrop[c] as number)) / a;
          data[i + c] = Math.round(Math.min(255, Math.max(0, v)));
        }
        data[i + 3] = Math.round((src[i + 3] as number) * a);
      }
    }
    if (vivid) {
      // 底色最亮的那个通道（绿底就是 G）不能比另外两个都高出去
      const others = Math.max(...[0, 1, 2].filter((c) => c !== top).map((c) => data[i + c] as number));
      if ((data[i + top] as number) > others) data[i + top] = others;
    }
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

/** 人物的外框（像素）：只算实心像素超过一行宽度 1% 的行，零星的杂点不算。没有人物时为 null。 */
export function figureBox(img: RgbaImage): { top: number; bottom: number; left: number; right: number } | null {
  const { width: w, height: h, data } = img;
  const min = Math.max(1, Math.floor(w * 0.01));
  let top = -1;
  let bottom = -1;
  let left = w;
  let right = -1;
  for (let y = 0; y < h; y++) {
    let l = -1;
    let r = -1;
    let n = 0;
    for (let x = 0; x < w; x++) {
      if ((data[(y * w + x) * 4 + 3] as number) >= 128) {
        if (l < 0) l = x;
        r = x;
        n++;
      }
    }
    if (n < min) continue;
    if (top < 0) top = y;
    bottom = y;
    left = Math.min(left, l);
    right = Math.max(right, r);
  }
  return top < 0 ? null : { top, bottom, left, right };
}

/**
 * 基础立绘的构图检查（19.8）：要的是膝盖以上的半身像，同一个世界的立绘才能在舞台上一样大。
 * 看人物外框的高宽比和底下的空白：又细又长、脚下还有空白的是全身像；人物不到画面高度的六成、
 * 或者又矮又宽的是只画了上半身。返回不对的原因（给人看），对了返回 null。
 */
export function checkFraming(img: RgbaImage): string | null {
  const box = figureBox(img);
  if (!box) return null;
  const fh = box.bottom - box.top + 1;
  const fw = box.right - box.left + 1;
  const ratio = fh / fw;
  const gap = (img.height - 1 - box.bottom) / img.height;
  if (ratio >= 3 || (ratio >= 2.6 && gap > 0.02)) return '画成了全身像（要的是膝盖以上的半身像），站在舞台上会比别人小一圈';
  if (fh / img.height < 0.6 || ratio < 1.3) return '只画了上半身（要的是膝盖以上的半身像），站在舞台上会比别人大一圈';
  return null;
}

/** 人物没画到底边（脚下或者腰下有一截空白）：整个往下挪到底边，站在舞台上不会悬在半空。不用挪时原样返回。 */
export function anchorBottom(img: RgbaImage): RgbaImage {
  const box = figureBox(img);
  if (!box) return img;
  const shift = img.height - 1 - box.bottom;
  if (shift <= Math.floor(img.height * 0.005)) return img;
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(data.length);
  out.set(data.subarray(0, (h - shift) * w * 4), shift * w * 4);
  return { width: w, height: h, data: out };
}
