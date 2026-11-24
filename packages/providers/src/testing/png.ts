import { encodeRgbaPng } from '../png.ts';

/**
 * 画一张简单的 PNG（RGBA）：给每个像素算颜色。测试和模拟服务用，不追求速度。
 */
export function encodePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  }
  return encodeRgbaPng({ width, height, data });
}

/** 字符串 → 一个稳定的颜色。 */
export function colorOf(text: string): [number, number, number] {
  let h = 0;
  for (const ch of text) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  const hue = h % 360;
  // HSL(hue, 45%, 45%) → RGB
  const s = 0.45;
  const l = 0.45;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** 模拟服务返回的图：按提示词着色，带一道斜向的浅色条纹，一眼能看出不是纯色占位。 */
export function mockImage(prompt: string, width: number, height: number): Buffer {
  const [r, g, b] = colorOf(prompt);
  return encodePng(width, height, (x, y) => {
    const stripe = Math.floor((x + y) / Math.max(8, Math.round(width / 12))) % 2 === 0;
    return stripe ? [r, g, b, 255] : [Math.min(255, r + 40), Math.min(255, g + 40), Math.min(255, b + 40), 255];
  });
}

/**
 * 模拟的立绘：纯色底上画一个人形（圆脑袋 + 梯形身子，下边到底，四周留空），颜色按提示词来，
 * 脸上按表情画一道不同颜色的"嘴"，一眼能看出是不同的差分。
 * backdrop：white / green 纯色底；transparent 透明底（模拟支持透明输出的服务）；noisy 杂乱的底（抠图检查不通过）。
 */
export function mockSprite(prompt: string, width: number, height: number, backdrop: 'white' | 'green' | 'transparent' | 'noisy', mouth = ''): Buffer {
  const [r, g, b] = colorOf(prompt.replace(/表情.*$/m, ''));
  const [mr, mg, mb] = colorOf(mouth || 'neutral');
  const cx = width / 2;
  const headY = height * 0.26;
  const headR = Math.min(width, height) * 0.16;
  const bodyTop = headY + headR * 0.9;
  return encodePng(width, height, (x, y) => {
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - headY;
    const inHead = dx * dx + dy * dy <= headR * headR;
    // 身子：从肩到底边越来越宽，但左右离边缘留空
    const t = (y - bodyTop) / (height - bodyTop);
    const half = width * (0.18 + 0.14 * Math.max(0, t));
    const inBody = y >= bodyTop && Math.abs(dx) <= half;
    const inMouth = inHead && Math.abs(dx) < headR * 0.4 && dy > headR * 0.3 && dy < headR * 0.55;
    if (inMouth) return [mr, mg, mb, 255];
    if (inHead || inBody) return [r, g, b, 255];
    switch (backdrop) {
      case 'green':
        return [0, 255, 0, 255];
      case 'transparent':
        return [0, 0, 0, 0];
      case 'noisy': {
        const n = (x * 7919 + y * 104729) % 255;
        return [n, (n * 3) % 255, (n * 7) % 255, 255];
      }
      default:
        return [255, 255, 255, 255];
    }
  });
}
