import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng, encodeRgbaPng } from '../src/index.ts';

/** 手写一个 PNG：给定颜色类型、位深度、每行的过滤方式和原始扫描行（不含过滤字节）。 */
function rawPng(o: {
  width: number;
  height: number;
  colorType: number;
  depth: number;
  rows: number[][];
  filters?: number[];
  plte?: number[];
  trns?: number[];
}): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = (crcTable[(c ^ x) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(o.width, 0);
  ihdr.writeUInt32BE(o.height, 4);
  ihdr[8] = o.depth;
  ihdr[9] = o.colorType;
  const bpp = Math.max(1, ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[o.colorType] as number) * o.depth >> 3);
  // 按过滤方式编码每一行
  const lines: number[] = [];
  o.rows.forEach((row, y) => {
    const f = o.filters?.[y] ?? 0;
    const prev = o.rows[y - 1] ?? row.map(() => 0);
    lines.push(f);
    row.forEach((x, i) => {
      const a = i >= bpp ? (row[i - bpp] as number) : 0;
      const b = y > 0 ? (prev[i] as number) : 0;
      const c = y > 0 && i >= bpp ? (prev[i - bpp] as number) : 0;
      const p = a + b - c;
      const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const pred = [0, a, b, (a + b) >> 1, pr][f] as number;
      lines.push((x - pred) & 0xff);
    });
  });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(o.plte ? [chunk('PLTE', Buffer.from(o.plte))] : []),
    ...(o.trns ? [chunk('tRNS', Buffer.from(o.trns))] : []),
    chunk('IDAT', deflateSync(Buffer.from(lines))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const px = (img: { width: number; data: Uint8Array }, x: number, y: number) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

describe('PNG 编解码', () => {
  it('RGBA 编码后能原样解回来', () => {
    const data = new Uint8Array(5 * 3 * 4).map((_, i) => (i * 37) & 0xff);
    const img = decodePng(encodeRgbaPng({ width: 5, height: 3, data }));
    expect(img.width).toBe(5);
    expect(img.height).toBe(3);
    expect([...img.data]).toEqual([...data]);
  });

  it('真彩 8 位：五种过滤方式都能解', () => {
    const rows = [
      [10, 20, 30, 200, 100, 50],
      [11, 21, 31, 201, 101, 51],
      [0, 255, 128, 64, 32, 16],
      [250, 5, 77, 1, 2, 3],
      [9, 9, 9, 99, 99, 99],
    ];
    const img = decodePng(rawPng({ width: 2, height: 5, colorType: 2, depth: 8, rows, filters: [0, 1, 2, 3, 4] }));
    expect(px(img, 1, 0)).toEqual([200, 100, 50, 255]);
    expect(px(img, 0, 2)).toEqual([0, 255, 128, 255]);
    expect(px(img, 0, 3)).toEqual([250, 5, 77, 255]);
    expect(px(img, 1, 4)).toEqual([99, 99, 99, 255]);
  });

  it('调色板 4 位带透明、灰度 2 位、灰度带透明、16 位 RGBA', () => {
    const pal = decodePng(
      rawPng({ width: 3, height: 1, colorType: 3, depth: 4, rows: [[0x01, 0x20]], plte: [255, 0, 0, 0, 255, 0, 0, 0, 255], trns: [255, 0] }),
    );
    expect(px(pal, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(pal, 1, 0)).toEqual([0, 255, 0, 0]);
    expect(px(pal, 2, 0)).toEqual([0, 0, 255, 255]);

    const gray = decodePng(rawPng({ width: 4, height: 1, colorType: 0, depth: 2, rows: [[0b00011011]] }));
    expect([0, 1, 2, 3].map((x) => px(gray, x, 0)[0])).toEqual([0, 85, 170, 255]);

    const ga = decodePng(rawPng({ width: 1, height: 1, colorType: 4, depth: 8, rows: [[120, 30]] }));
    expect(px(ga, 0, 0)).toEqual([120, 120, 120, 30]);

    const deep = decodePng(rawPng({ width: 1, height: 1, colorType: 6, depth: 16, rows: [[0x12, 0x34, 0xab, 0xcd, 0xff, 0x00, 0x80, 0x00]] }));
    expect(px(deep, 0, 0)).toEqual([0x12, 0xab, 0xff, 0x80]);
  });

  it('不是 PNG、隔行扫描的 PNG：报错', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(/不是 PNG/);
    const png = rawPng({ width: 1, height: 1, colorType: 2, depth: 8, rows: [[1, 2, 3]] });
    png[8 + 8 + 12] = 1; // IHDR 的隔行扫描字节（CRC 不检查）
    expect(() => decodePng(png)).toThrow(/隔行扫描/);
  });
});
