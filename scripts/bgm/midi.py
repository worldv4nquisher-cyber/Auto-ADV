"""让乐谱导出的 MIDI 弹得像人一点（build.py 用）。

- 速度：整体乘一个倍数（乐谱没写速度或写得不合常见演奏时）。
- 力度：把 CC7（音量）上的强弱并进音符力度，CC7 固定为 100；整体缩放到给定的中位数；
  同时按下的几个音里最高的稍重、中间的稍轻；加一点固定种子的随机起伏。
- 踏板：keep 保留乐谱里的踏板；bar / half / beat 按小节、半小节、拍换踏板（抬起在新和声开头，稍后再踩下）；none 不踩。
"""
import random
import struct


def vlq(b, i):
    v = 0
    while True:
        c = b[i]
        i += 1
        v = (v << 7) | (c & 0x7F)
        if not c & 0x80:
            return v, i


def wvlq(v):
    out = [v & 0x7F]
    v >>= 7
    while v:
        out.append(0x80 | (v & 0x7F))
        v >>= 7
    return bytes(reversed(out))


def read(path):
    b = open(path, 'rb').read()
    _, fmt, ntrk, div = struct.unpack('>IHHH', b[4:14])
    if div & 0x8000:
        raise ValueError(f'{path}：不支持 SMPTE 时间')
    i = 14
    tracks = []
    for _ in range(ntrk):
        ln = struct.unpack('>I', b[i + 4:i + 8])[0]
        j = i + 8
        end = j + ln
        t = 0
        status = 0
        evs = []  # (tick, kind, data)；kind: 'meta'(type, bytes) / 'sysex'(raw) / 'midi'(status, d1, d2|None)
        while j < end:
            dt, j = vlq(b, j)
            t += dt
            c = b[j]
            if c == 0xFF:
                typ = b[j + 1]
                l, k = vlq(b, j + 2)
                evs.append((t, 'meta', (typ, b[k:k + l])))
                j = k + l
                continue
            if c in (0xF0, 0xF7):
                l, k = vlq(b, j + 1)
                evs.append((t, 'sysex', (c, b[k:k + l])))
                j = k + l
                continue
            if c & 0x80:
                status = c
                j += 1
            hi = status & 0xF0
            if hi in (0xC0, 0xD0):
                evs.append((t, 'midi', (status, b[j], None)))
                j += 1
            else:
                evs.append((t, 'midi', (status, b[j], b[j + 1])))
                j += 2
        tracks.append(evs)
        i = end
    return fmt, div, tracks


def write(path, fmt, div, tracks):
    out = bytearray(b'MThd' + struct.pack('>IHHH', 6, fmt, len(tracks), div))
    for evs in tracks:
        body = bytearray()
        last = 0
        # 同一时刻：先抬踏板、先关音，再开音、再踩踏板
        def order(e):
            t, kind, d = e
            if kind == 'meta':
                return (t, 0 if d[0] != 0x2F else 9)
            if kind == 'midi':
                s, d1, d2 = d
                hi = s & 0xF0
                if hi == 0xB0 and d1 == 64:
                    return (t, 1 if d2 < 64 else 6)
                if hi == 0x80 or (hi == 0x90 and d2 == 0):
                    return (t, 2)
                if hi == 0x90:
                    return (t, 5)
                return (t, 3)
            return (t, 4)
        for t, kind, d in sorted(evs, key=order):
            body += wvlq(t - last)
            last = t
            if kind == 'meta':
                body += bytes([0xFF, d[0]]) + wvlq(len(d[1])) + d[1]
            elif kind == 'sysex':
                body += bytes([d[0]]) + wvlq(len(d[1])) + d[1]
            else:
                s, d1, d2 = d
                body += bytes([s, d1]) if d2 is None else bytes([s, d1, d2])
        out += b'MTrk' + struct.pack('>I', len(body)) + body
    open(path, 'wb').write(out)


def bar_grid(tracks, div, end, mode):
    """按拍号算出换踏板的时刻。"""
    sigs = sorted((t, d[1][0], 2 ** d[1][1]) for evs in tracks for t, k, d in evs if k == 'meta' and d[0] == 0x58)
    if not sigs or sigs[0][0] > 0:
        sigs.insert(0, (0, 4, 4))
    marks = []
    for n, (t0, num, den) in enumerate(sigs):
        t1 = sigs[n + 1][0] if n + 1 < len(sigs) else end
        bar = num * div * 4 // den
        if mode == 'bar':
            step = bar
        elif mode == 'half':
            step = bar // 2 if num % 2 == 0 or num % 3 else bar
        else:  # beat：复合拍子（6/8、9/8、12/8）一拍是三个八分音符
            step = div * 4 // den * (3 if den >= 8 and num % 3 == 0 and num > 3 else 1)
        t = t0
        while t < t1:
            marks.append(t)
            t += max(1, step)
    return marks


def humanize(src, dst, pedal, median, factor=1.0):
    """读 src、处理后写到 dst，返回一行说明。"""
    fmt, div, tracks = read(src)
    for evs in tracks:
        for n, (t, kind, d) in enumerate(evs):
            if kind == 'meta' and d[0] == 0x51:
                us = round(int.from_bytes(d[1], 'big') / factor)
                evs[n] = (t, kind, (0x51, us.to_bytes(3, 'big')))
    rnd = random.Random(20261125)
    end = max((e[0] for evs in tracks for e in evs), default=0)

    # 1. CC7 并进力度
    notes = []  # (track, index, tick, pitch, eff)
    for ti, evs in enumerate(tracks):
        vol = {}
        keep = []
        for t, kind, d in evs:
            if kind == 'midi':
                s, d1, d2 = d
                hi, ch = s & 0xF0, s & 0x0F
                if hi == 0xB0 and d1 == 7:
                    vol[ch] = d2
                    continue
                if hi == 0x90 and d2:
                    eff = d2 * (vol.get(ch, 100) / 100.0)
                    notes.append([ti, len(keep), t, d1, eff])
            keep.append((t, kind, d))
        tracks[ti] = keep
    if not notes:
        raise ValueError(f'{src}：没有音符')

    # 2. 缩放到给定的中位数
    effs = sorted(n[4] for n in notes)
    med = effs[len(effs) // 2] or 1
    scale = median / med

    # 3. 同时按下的音：最高的重一点，中间的轻一点
    by_tick = {}
    for n in notes:
        by_tick.setdefault(n[2] // max(1, div // 32), []).append(n)
    for group in by_tick.values():
        if len(group) < 2:
            continue
        hi_p = max(n[3] for n in group)
        lo_p = min(n[3] for n in group)
        for n in group:
            n[4] *= 1.12 if n[3] == hi_p else (1.0 if n[3] == lo_p else 0.88)

    for ti, idx, t, p, eff in notes:
        v = eff * scale * (1 + rnd.uniform(-0.05, 0.05))
        tt, kind, (s, d1, _) = tracks[ti][idx]
        tracks[ti][idx] = (tt, kind, (s, d1, max(18, min(118, round(v)))))

    # 4. CC7 固定为 100，乐器统一成大钢琴
    chans = {}
    for ti, evs in enumerate(tracks):
        for t, kind, d in evs:
            if kind == 'midi' and d[0] & 0xF0 == 0x90:
                chans.setdefault(ti, set()).add(d[0] & 0x0F)
    for ti, cs in chans.items():
        tracks[ti] = [e for e in tracks[ti] if not (e[1] == 'midi' and e[2][0] & 0xF0 == 0xC0)]
        for ch in cs:
            tracks[ti].append((0, 'midi', (0xC0 | ch, 0, None)))
            tracks[ti].append((0, 'midi', (0xB0 | ch, 7, 100)))

    # 5. 踏板
    has_pedal = any(k == 'midi' and d[0] & 0xF0 == 0xB0 and d[1] == 64 for evs in tracks for _, k, d in evs)
    if pedal == 'keep' and not has_pedal:
        raise ValueError(f'{src}：选了 keep，但 MIDI 里没有踏板')
    if pedal not in ('keep', 'none'):
        tracks = [[e for e in evs if not (e[1] == 'midi' and e[2][0] & 0xF0 == 0xB0 and e[2][1] == 64)] for evs in tracks]
        first = min(n[2] for n in notes)
        last_off = end
        marks = [m for m in bar_grid(tracks, div, end, pedal) if first <= m < last_off] or [first]
        if marks[0] > first:
            marks.insert(0, first)
        lag = max(1, div // 8)
        for ti, cs in chans.items():
            for ch in cs:
                for m in marks:
                    if m > first:
                        tracks[ti].append((m, 'midi', (0xB0 | ch, 64, 0)))
                    tracks[ti].append((m + lag, 'midi', (0xB0 | ch, 64, 127)))
                tracks[ti].append((end, 'midi', (0xB0 | ch, 64, 0)))
    write(dst, fmt, div, tracks)
    vs = sorted(d[2] for evs in tracks for _, k, d in evs if k == 'midi' and d[0] & 0xF0 == 0x90 and d[2])
    return f'音符 {len(vs)}，力度 p5/p50/p95 {vs[len(vs) // 20]}/{vs[len(vs) // 2]}/{vs[len(vs) * 19 // 20]}，踏板 {pedal}，速度 ×{factor}'
