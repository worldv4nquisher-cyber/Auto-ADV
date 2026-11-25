import { deflateSync, inflateSync } from 'node:zlib';

/**
 * 不依赖任何库的 PNG 编解码（立绘抠图用，18.5）。
 * 解码支持所有颜色类型（灰度、真彩、调色板，带不带透明）和 1～16 位深度，统一转成 8 位 RGBA；
 * 不支持隔行扫描（Adam7），图像模型基本不出这种图，遇到就报错，由调用方退回不抠图。
 */

export interface RgbaImage {
  width: number;
  height: number;
  /** 每个像素 4 个字节：R、G、B、A。 */
  data: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ (buf[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function isPng(data: Uint8Array): boolean {
  return SIGNATURE.every((b, i) => data[i] === b);
}

/** 8 位 RGBA 编码成 PNG。每行用 Sub 过滤（对立绘这种大块纯色、大块透明的图压缩得不错）。 */
export function encodeRgbaPng(img: RgbaImage): Buffer {
  const { width, height, data } = img;
  if (data.length !== width * height * 4) throw new Error('像素数据的长度和尺寸对不上');
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    const r = y * stride;
    raw[o] = 1; // Sub
    for (let i = 0; i < stride; i++) {
      const left = i >= 4 ? (data[r + i - 4] as number) : 0;
      raw[o + 1 + i] = ((data[r + i] as number) - left) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深度
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array()),
  ]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** 解码 PNG，转成 8 位 RGBA。 */
export function decodePng(input: Uint8Array): RgbaImage {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!isPng(buf)) throw new Error('不是 PNG 图片');
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (body.length !== len) throw new Error('PNG 文件不完整');
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8] as number;
      colorType = body[9] as number;
      interlace = body[12] as number;
    } else if (type === 'PLTE') {
      palette = body;
    } else if (type === 'tRNS') {
      trns = body;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (!width || !height) throw new Error('PNG 缺少文件头');
  if (interlace) throw new Error('不支持隔行扫描的 PNG');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth)) throw new Error(`不支持的 PNG 格式（颜色类型 ${colorType}，位深度 ${depth}）`);
  if (colorType === 3 && !palette) throw new Error('调色板 PNG 缺少调色板');

  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3); // 过滤时"左边一个像素"的字节数
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error('PNG 数据不完整');

  // 去掉每行的过滤
  const lines = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] as number;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i] as number;
      const a = i >= bpp ? (lines[dst + i - bpp] as number) : 0;
      const b = y > 0 ? (lines[up + i] as number) : 0;
      const c = y > 0 && i >= bpp ? (lines[up + i - bpp] as number) : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        case 4:
          v = x + paeth(a, b, c);
          break;
        default:
          throw new Error(`PNG 里有不认识的过滤方式 ${filter}`);
      }
      lines[dst + i] = v & 0xff;
    }
  }

  // 读第 n 个样本（按位深度），统一成 0～255
  const maxv = (1 << Math.min(depth, 8)) - 1;
  const sample = (row: number, n: number): number => {
    if (depth === 8) return lines[row + n] as number;
    if (depth === 16) return lines[row + n * 2] as number; // 取高字节
    const bit = n * depth;
    const byte = lines[row + (bit >> 3)] as number;
    return (byte >> (8 - depth - (bit & 7))) & maxv;
  };
  const scale = (v: number) => (depth >= 8 ? v : Math.round((v * 255) / maxv));
  // tRNS 里的透明色（灰度、真彩时），按原始位深度比较
  const rawSample = (row: number, n: number): number =>
    depth === 16 ? ((lines[row + n * 2] as number) << 8) | (lines[row + n * 2 + 1] as number) : sample(row, n);
  const key = trns && colorType !== 3 ? Array.from({ length: trns.length / 2 }, (_, i) => trns.readUInt16BE(i * 2)) : null;

  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r: number;
      let g: number;
      let b: number;
      let a = 255;
      switch (colorType) {
        case 0: {
          r = g = b = scale(sample(row, x));
          if (key && rawSample(row, x) === key[0]) a = 0;
          break;
        }
        case 2: {
          r = sample(row, x * 3);
          g = sample(row, x * 3 + 1);
          b = sample(row, x * 3 + 2);
          if (key && rawSample(row, x * 3) === key[0] && rawSample(row, x * 3 + 1) === key[1] && rawSample(row, x * 3 + 2) === key[2]) a = 0;
          break;
        }
        case 3: {
          const idx = sample(row, x);
          r = (palette as Uint8Array)[idx * 3] ?? 0;
          g = (palette as Uint8Array)[idx * 3 + 1] ?? 0;
          b = (palette as Uint8Array)[idx * 3 + 2] ?? 0;
          if (trns && idx < trns.length) a = trns[idx] as number;
          break;
        }
        case 4: {
          r = g = b = sample(row, x * 2);
          a = sample(row, x * 2 + 1);
          break;
        }
        default: {
          r = sample(row, x * 4);
          g = sample(row, x * 4 + 1);
          b = sample(row, x * 4 + 2);
          a = sample(row, x * 4 + 3);
        }
      }
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  }
  return { width, height, data: out };
}
