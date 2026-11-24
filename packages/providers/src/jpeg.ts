import type { RgbaImage } from './png.ts';

/**
 * 不依赖任何库的 JPEG 解码（立绘抠图用，18.5、19.2）。有的图像服务（比如 H3）返回 JPEG，内置抠图要先解出像素。
 * 支持基线和扩展的顺序编码（SOF0、SOF1，8 位，哈夫曼编码）：灰度和 YCbCr / RGB 三通道，任意采样比例，重启间隔。
 * 不支持渐进式、无损、算术编码、12 位和 CMYK，遇到就报错，由调用方退回不抠图。
 */

export function isJpeg(data: Uint8Array): boolean {
  return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
}

/** 之字形顺序 → 8x8 块里的位置。 */
const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57,
  50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

/** IDCT 的系数：COS[u * 8 + x] = c(u) / 2 · cos((2x + 1)uπ / 16)。 */
const COS = (() => {
  const t = new Float64Array(64);
  for (let u = 0; u < 8; u++) {
    const c = u === 0 ? Math.SQRT1_2 : 1;
    for (let x = 0; x < 8; x++) t[u * 8 + x] = (c / 2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
  return t;
})();

interface Huffman {
  maxcode: Int32Array;
  valptr: Int32Array;
  mincode: Int32Array;
  values: Uint8Array;
}

function buildHuffman(counts: Uint8Array, values: Uint8Array): Huffman {
  const maxcode = new Int32Array(18).fill(-1);
  const valptr = new Int32Array(17);
  const mincode = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    const n = counts[l - 1] as number;
    valptr[l] = k;
    mincode[l] = code;
    code += n;
    k += n;
    if (n) maxcode[l] = code - 1;
    code <<= 1;
  }
  return { maxcode, valptr, mincode, values };
}

interface Component {
  id: number;
  h: number;
  v: number;
  tq: number;
  /** 这个分量的采样平面（按整块对齐）。 */
  plane: Uint8Array;
  lineW: number;
  dc: number;
  ht: number;
  at: number;
}

class BitReader {
  private buf = 0;
  private cnt = 0;
  /** 扫描数据里遇到的标记（不是 0xFF00 填充）；之后只读出 0。 */
  marker: number | null = null;
  private readonly d: Uint8Array;
  pos: number;
  constructor(d: Uint8Array, pos: number) {
    this.d = d;
    this.pos = pos;
  }

  private byte(): number {
    if (this.marker !== null) return 0;
    if (this.pos >= this.d.length) {
      this.marker = 0xd9;
      return 0;
    }
    const b = this.d[this.pos] as number;
    if (b !== 0xff) {
      this.pos++;
      return b;
    }
    const next = this.d[this.pos + 1];
    if (next === 0x00) {
      this.pos += 2;
      return 0xff;
    }
    if (next === 0xff) {
      // 标记前面的填充字节
      this.pos++;
      return this.byte();
    }
    this.marker = next ?? 0xd9;
    return 0;
  }

  bit(): number {
    if (this.cnt === 0) {
      this.buf = this.byte();
      this.cnt = 8;
    }
    this.cnt--;
    return (this.buf >> this.cnt) & 1;
  }

  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v;
  }

  decode(t: Huffman): number {
    let code = this.bit();
    for (let l = 1; l <= 16; l++) {
      if (code <= (t.maxcode[l] as number)) return t.values[(t.valptr[l] as number) + code - (t.mincode[l] as number)] as number;
      code = (code << 1) | this.bit();
    }
    throw new Error('JPEG 数据损坏（哈夫曼编码对不上）');
  }

  /** 重启间隔到了：丢掉剩下的位，跳过 RSTn 标记。 */
  restart(): void {
    this.cnt = 0;
    if (this.marker === null) {
      while (this.d[this.pos] === 0xff && this.d[this.pos + 1] === 0xff) this.pos++;
      if (this.d[this.pos] === 0xff) this.marker = this.d[this.pos + 1] ?? null;
    }
    if (this.marker !== null && this.marker >= 0xd0 && this.marker <= 0xd7) {
      this.pos += 2;
      this.marker = null;
    }
  }
}

const extend = (v: number, s: number) => (v < 1 << (s - 1) ? v - (1 << s) + 1 : v);

/** 解一个 8x8 块，反量化以后做 IDCT，写进分量的采样平面。 */
function decodeBlock(
  bits: BitReader,
  c: Component,
  dcT: Huffman,
  acT: Huffman,
  q: Int32Array,
  bx: number,
  by: number,
  coef: Float64Array,
  tmp: Float64Array,
): void {
  coef.fill(0);
  const t = bits.decode(dcT);
  if (t) c.dc += extend(bits.bits(t), t);
  coef[0] = c.dc * (q[0] as number);
  for (let k = 1; k < 64; ) {
    const rs = bits.decode(acT);
    const r = rs >> 4;
    const s = rs & 15;
    if (s === 0) {
      if (r !== 15) break;
      k += 16;
      continue;
    }
    k += r;
    if (k > 63) break;
    coef[ZIGZAG[k] as number] = extend(bits.bits(s), s) * (q[k] as number);
    k++;
  }
  // 先对每一行（固定垂直频率 v）做一维 IDCT，再对每一列
  for (let v = 0; v < 8; v++) {
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let u = 0; u < 8; u++) sum += (COS[u * 8 + x] as number) * (coef[v * 8 + u] as number);
      tmp[v * 8 + x] = sum;
    }
  }
  const base = by * 8 * c.lineW + bx * 8;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let v = 0; v < 8; v++) sum += (COS[v * 8 + y] as number) * (tmp[v * 8 + x] as number);
      const p = Math.round(sum + 128);
      c.plane[base + y * c.lineW + x] = p < 0 ? 0 : p > 255 ? 255 : p;
    }
  }
}

export function decodeJpeg(input: Uint8Array): RgbaImage {
  const d = input;
  if (!isJpeg(d)) throw new Error('不是 JPEG 文件');
  const u16 = (i: number) => (((d[i] as number) << 8) | (d[i + 1] as number)) >>> 0;
  const quant: (Int32Array | undefined)[] = [];
  const dcTables: (Huffman | undefined)[] = [];
  const acTables: (Huffman | undefined)[] = [];
  let comps: Component[] = [];
  let width = 0;
  let height = 0;
  let maxH = 1;
  let maxV = 1;
  let mcusX = 0;
  let mcusY = 0;
  let restartInterval = 0;
  let adobeTransform: number | null = null;
  let frame = false;
  let pos = 2;
  const coef = new Float64Array(64);
  const tmp = new Float64Array(64);

  while (pos < d.length) {
    if (d[pos] !== 0xff) {
      pos++;
      continue;
    }
    const m = d[pos + 1] as number;
    if (m === 0xff || m === 0x00 || (m >= 0xd0 && m <= 0xd7)) {
      pos++;
      continue;
    }
    if (m === 0xd9) break;
    const len = u16(pos + 2);
    const seg = pos + 4;
    const end = pos + 2 + len;
    if (end > d.length) throw new Error('JPEG 文件不完整');
    switch (m) {
      case 0xdb: {
        // 量化表
        let i = seg;
        while (i < end) {
          const pq = (d[i] as number) >> 4;
          const tq = (d[i] as number) & 15;
          const t = new Int32Array(64);
          for (let k = 0; k < 64; k++) t[k] = pq ? u16(i + 1 + k * 2) : (d[i + 1 + k] as number);
          quant[tq] = t;
          i += 1 + 64 * (pq ? 2 : 1);
        }
        break;
      }
      case 0xc4: {
        // 哈夫曼表
        let i = seg;
        while (i < end) {
          const tc = (d[i] as number) >> 4;
          const th = (d[i] as number) & 15;
          const counts = d.subarray(i + 1, i + 17);
          const total = counts.reduce((a, b) => a + b, 0);
          const t = buildHuffman(counts, d.slice(i + 17, i + 17 + total));
          (tc === 0 ? dcTables : acTables)[th] = t;
          i += 17 + total;
        }
        break;
      }
      case 0xdd:
        restartInterval = u16(seg);
        break;
      case 0xee:
        // Adobe：第 11 个字节是颜色变换（0 是 RGB，1 是 YCbCr）
        if (len >= 14 && String.fromCharCode(...d.subarray(seg, seg + 5)) === 'Adobe') adobeTransform = d[seg + 11] as number;
        break;
      case 0xc0:
      case 0xc1: {
        if (d[seg] !== 8) throw new Error(`不支持 ${d[seg]} 位的 JPEG`);
        height = u16(seg + 1);
        width = u16(seg + 3);
        if (!width || !height) throw new Error('JPEG 没写图像尺寸');
        const n = d[seg + 5] as number;
        if (n !== 1 && n !== 3) throw new Error(n === 4 ? '不支持 CMYK 的 JPEG' : `不支持 ${n} 个颜色分量的 JPEG`);
        comps = [];
        for (let k = 0; k < n; k++) {
          const b = seg + 6 + k * 3;
          comps.push({
            id: d[b] as number,
            h: Math.max(1, (d[b + 1] as number) >> 4),
            v: Math.max(1, (d[b + 1] as number) & 15),
            tq: d[b + 2] as number,
            plane: new Uint8Array(0),
            lineW: 0,
            dc: 0,
            ht: 0,
            at: 0,
          });
        }
        maxH = Math.max(...comps.map((c) => c.h));
        maxV = Math.max(...comps.map((c) => c.v));
        mcusX = Math.ceil(width / (8 * maxH));
        mcusY = Math.ceil(height / (8 * maxV));
        for (const c of comps) {
          c.lineW = mcusX * c.h * 8;
          c.plane = new Uint8Array(c.lineW * mcusY * c.v * 8);
        }
        frame = true;
        break;
      }
      case 0xda: {
        if (!frame) throw new Error('JPEG 在帧头之前开始了扫描');
        const ns = d[seg] as number;
        const scan: Component[] = [];
        for (let k = 0; k < ns; k++) {
          const c = comps.find((x) => x.id === d[seg + 1 + k * 2]);
          if (!c) throw new Error('JPEG 扫描里的颜色分量对不上');
          c.ht = (d[seg + 2 + k * 2] as number) >> 4;
          c.at = (d[seg + 2 + k * 2] as number) & 15;
          c.dc = 0;
          scan.push(c);
        }
        const bits = new BitReader(d, end);
        const table = (c: Component) => {
          const q = quant[c.tq];
          const dcT = dcTables[c.ht];
          const acT = acTables[c.at];
          if (!q || !dcT || !acT) throw new Error('JPEG 缺少量化表或哈夫曼表');
          return { q, dcT, acT };
        };
        const tables = scan.map(table);
        let done = 0;
        const step = () => {
          done++;
          if (restartInterval && done % restartInterval === 0) {
            bits.restart();
            for (const c of scan) c.dc = 0;
          }
        };
        if (scan.length === 1) {
          // 不交错的扫描：一个 MCU 就是一块，只覆盖这个分量实际的大小
          const c = scan[0] as Component;
          const { q, dcT, acT } = tables[0] as ReturnType<typeof table>;
          const bw = Math.ceil(Math.ceil((width * c.h) / maxH) / 8);
          const bh = Math.ceil(Math.ceil((height * c.v) / maxV) / 8);
          for (let by = 0; by < bh; by++) {
            for (let bx = 0; bx < bw; bx++) {
              decodeBlock(bits, c, dcT, acT, q, bx, by, coef, tmp);
              step();
            }
          }
        } else {
          for (let my = 0; my < mcusY; my++) {
            for (let mx = 0; mx < mcusX; mx++) {
              for (let k = 0; k < scan.length; k++) {
                const c = scan[k] as Component;
                const { q, dcT, acT } = tables[k] as ReturnType<typeof table>;
                for (let v = 0; v < c.v; v++) {
                  for (let h = 0; h < c.h; h++) decodeBlock(bits, c, dcT, acT, q, mx * c.h + h, my * c.v + v, coef, tmp);
                }
              }
              step();
            }
          }
        }
        // 扫描数据之后接着找下一个标记
        pos = bits.pos;
        continue;
      }
      default:
        if (m === 0xc2 || m === 0xc6 || m === 0xca || m === 0xce) throw new Error('不支持渐进式 JPEG');
        // 其余的帧头（无损、分层、算术编码，DAC 也只跟算术编码一起出现）不支持；APPn、COM 这些跳过
        if (m >= 0xc3 && m <= 0xcf && m !== 0xc4 && m !== 0xc8) throw new Error('不支持这种 JPEG 编码（无损或算术编码）');
    }
    pos = end;
  }
  if (!frame) throw new Error('JPEG 里没有图像');

  // 分量平面 → RGBA。色度分量采样少的，按采样点中心做双线性插值放大
  const out = new Uint8Array(width * height * 4);
  const sample = (c: Component, x: number, y: number): number => {
    if (c.h === maxH && c.v === maxV) return c.plane[y * c.lineW + x] as number;
    const sx = Math.max(0, ((x + 0.5) * c.h) / maxH - 0.5);
    const sy = Math.max(0, ((y + 0.5) * c.v) / maxV - 0.5);
    const cw = Math.ceil((width * c.h) / maxH);
    const ch = Math.ceil((height * c.v) / maxV);
    const x0 = Math.min(Math.floor(sx), cw - 1);
    const y0 = Math.min(Math.floor(sy), ch - 1);
    const x1 = Math.min(x0 + 1, cw - 1);
    const y1 = Math.min(y0 + 1, ch - 1);
    const fx = sx - Math.floor(sx);
    const fy = sy - Math.floor(sy);
    const p = c.plane;
    const w = c.lineW;
    const top = (p[y0 * w + x0] as number) * (1 - fx) + (p[y0 * w + x1] as number) * fx;
    const bottom = (p[y1 * w + x0] as number) * (1 - fx) + (p[y1 * w + x1] as number) * fx;
    return top * (1 - fy) + bottom * fy;
  };
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  const rgb = comps.length === 3 && (adobeTransform === 0 || (comps[0]?.id === 0x52 && comps[1]?.id === 0x47 && comps[2]?.id === 0x42));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (comps.length === 1) {
        const g = sample(comps[0] as Component, x, y);
        out[i] = out[i + 1] = out[i + 2] = clamp(g);
      } else {
        const a = sample(comps[0] as Component, x, y);
        const b = sample(comps[1] as Component, x, y);
        const c = sample(comps[2] as Component, x, y);
        if (rgb) {
          out[i] = clamp(a);
          out[i + 1] = clamp(b);
          out[i + 2] = clamp(c);
        } else {
          out[i] = clamp(a + 1.402 * (c - 128));
          out[i + 1] = clamp(a - 0.344136 * (b - 128) - 0.714136 * (c - 128));
          out[i + 2] = clamp(a + 1.772 * (b - 128));
        }
      }
      out[i + 3] = 255;
    }
  }
  return { width, height, data: out };
}
