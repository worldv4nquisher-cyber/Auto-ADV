import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeJpeg, decodePng, isJpeg } from '../src/index.ts';

// 夹具是用 Pillow（libjpeg）编出来的 45x37 小图（渐变底上 4 个色块），旁边的 PNG 是 Pillow 解出来的结果
const FIXTURES = path.resolve(import.meta.dirname, 'fixtures');
const read = (name: string) => new Uint8Array(readFileSync(path.join(FIXTURES, name)));

/** 和 Pillow 解出来的比：平均差和最大差（RGB 三个通道）。 */
function compare(name: string) {
  const ours = decodeJpeg(read(`${name}.jpg`));
  const ref = decodePng(read(`${name}.png`));
  expect([ours.width, ours.height]).toEqual([ref.width, ref.height]);
  let sum = 0;
  let max = 0;
  for (let i = 0; i < ours.data.length; i++) {
    if (i % 4 === 3) {
      expect(ours.data[i]).toBe(255);
      continue;
    }
    const d = Math.abs((ours.data[i] as number) - (ref.data[i] as number));
    sum += d;
    max = Math.max(max, d);
  }
  return { mean: sum / (ours.width * ours.height * 3), max, img: ours };
}

describe('JPEG 解码', () => {
  it('4:2:0、4:2:2、4:4:4 带重启标记：和 libjpeg 解出来的几乎一样', () => {
    for (const name of ['ycc420', 'ycc422', 'ycc444-restart']) {
      const { mean, max, img } = compare(name);
      // IDCT 和色度放大的算法和 libjpeg 不完全一样，差一两个数
      expect(mean, name).toBeLessThan(1);
      expect(max, name).toBeLessThan(8);
      // 色块中间的颜色
      const at = (x: number, y: number) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];
      for (const [x, y, rgb] of [
        [8, 7, [220, 30, 40]],
        [34, 9, [20, 160, 60]],
        [11, 27, [30, 50, 200]],
        [33, 27, [250, 250, 250]],
      ] as const) {
        at(x, y).forEach((v, c) => expect(Math.abs(v - (rgb[c] as number)), `${name} ${x},${y}`).toBeLessThan(12));
      }
    }
  });

  it('灰度（只有一个分量的扫描，尺寸不是 8 的倍数）', () => {
    const { mean, max } = compare('gray');
    expect(mean).toBeLessThan(0.5);
    expect(max).toBeLessThan(4);
  });

  it('不是 JPEG、渐进式 JPEG、截断的文件：报错', () => {
    expect(isJpeg(read('ycc420.jpg'))).toBe(true);
    expect(isJpeg(read('ycc420.png'))).toBe(false);
    expect(() => decodeJpeg(read('ycc420.png'))).toThrow('不是 JPEG');
    expect(() => decodeJpeg(read('progressive.jpg'))).toThrow('渐进式');
    expect(() => decodeJpeg(read('ycc420.jpg').subarray(0, 300))).toThrow();
  });
});
