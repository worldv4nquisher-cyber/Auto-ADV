/** 音频文件的小工具：按文件头认格式、写 WAV（模拟服务和测试用）。 */

/** 按文件头认出音频格式。认不出来时为 null。 */
export function sniffAudio(data: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...data.subarray(from, to));
  if (data.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (data.length >= 4 && ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (data.length >= 4 && ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (data.length >= 3 && ascii(0, 3) === 'ID3') return 'audio/mpeg';
  // MPEG 音频帧同步字（11 个 1）：MP3 不带 ID3 标签时以它开头
  if (data.length >= 2 && data[0] === 0xff && ((data[1] as number) & 0xe0) === 0xe0 && ((data[1] as number) & 0x06) !== 0) return 'audio/mpeg';
  if (data.length >= 12 && ascii(4, 8) === 'ftyp') return 'audio/mp4';
  return null;
}

export const AUDIO_EXT: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/mp4': 'm4a',
};

/** 能放进曲库、能上传的音频文件扩展名。 */
export const AUDIO_EXTENSIONS = ['mp3', 'ogg', 'opus', 'oga', 'wav', 'flac', 'm4a', 'aac'] as const;

/** 按扩展名取 MIME（本地曲库按文件名认，不读文件头）。 */
export function audioMimeOf(file: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase();
  switch (ext) {
    case 'mp3':
      return 'audio/mpeg';
    case 'ogg':
    case 'oga':
    case 'opus':
      return 'audio/ogg';
    case 'wav':
      return 'audio/wav';
    case 'flac':
      return 'audio/flac';
    case 'm4a':
    case 'aac':
      return 'audio/mp4';
    default:
      return null;
  }
}

/** 16 位单声道 PCM 写成 WAV。samples 是 -1～1 的浮点数。 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = samples.length * 2;
  const out = new Uint8Array(44 + bytes);
  const v = new DataView(out.buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  text(0, 'RIFF');
  v.setUint32(4, 36 + bytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // 单声道
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, bytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] as number));
    v.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return out;
}

/** WAV 的时长（毫秒）。不是 WAV 或者读不出来时为 null。 */
export function wavDurationMs(data: Uint8Array): number | null {
  if (sniffAudio(data) !== 'audio/wav' || data.length < 44) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const byteRate = v.getUint32(28, true);
  let at = 12;
  while (at + 8 <= data.length) {
    const id = String.fromCharCode(...data.subarray(at, at + 4));
    const size = v.getUint32(at + 4, true);
    if (id === 'data') return byteRate ? Math.round((size / byteRate) * 1000) : null;
    at += 8 + size + (size % 2);
  }
  return null;
}
