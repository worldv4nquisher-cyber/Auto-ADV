"""重新做内置曲库（resources/bgm）：python3 scripts/bgm/build.py [--cache 文件夹] [曲目 id...]

每首曲子：
1. 从 Mutopia 下载 LilyPond 乐谱，确认乐谱头里标的是 Public Domain（不是就停下）；
2. convert-ly 升级到本机的 LilyPond，去掉乐谱里"MIDI 不要强弱"的设置，给出 MIDI 的 \\score 加上展开反复和 articulate；
3. LilyPond 导出 MIDI，midi.py 调速度、力度、踏板；
4. FluidSynth 用 MuseScore General 音色库渲染，ffmpeg 两遍 loudnorm 把响度统一到 -20 LUFS，去掉结尾静音，压成 Opus 64 kbps；
5. 写 resources/bgm/manifest.json。

需要：lilypond（2.24）、fluidsynth、ffmpeg（带 libopus）、MuseScore General 音色库（Debian / Ubuntu 的 musescore-general-soundfont-lossless）。
"""
import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile

from midi import humanize

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(REPO, 'resources', 'bgm')
SF2 = '/usr/share/sounds/sf2/MuseScore_General_Full.sf2'
MUTOPIA = 'https://www.mutopiaproject.org'
TARGET_I = -20.0
TARGET_TP = -1.5
METHOD = (
    '用 LilyPond 2.24 从 Mutopia 的乐谱导出 MIDI（展开反复，补上力度和踏板），'
    '再用 FluidSynth 和 MuseScore General 音色库渲染，响度统一到 -20 LUFS，Opus 64 kbps'
)
SOUNDFONT_LICENSE = '音色库：MuseScore General（MIT；钢琴采样为公有领域）'


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def get(url):
    for i in range(3):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return r.read()
        except OSError as e:
            if i == 2:
                raise
            print(f'  重试 {url}：{e}', file=sys.stderr)
            time.sleep(3 * (i + 1))


def download(pid, dst):
    """下载乐谱（.ly 或 -lys.zip）到 dst，返回曲目页地址。"""
    info = f'{MUTOPIA}/cgibin/piece-info.cgi?id={pid}'
    if os.path.isdir(dst) and os.listdir(dst):
        return info
    os.makedirs(dst, exist_ok=True)
    page = get(info).decode('utf-8', 'replace')
    links = sorted(set(re.findall(r'href="(https://www\.mutopiaproject\.org/ftp/[^"]+(?:\.ly|-lys\.zip))"', page)))
    if not links:
        raise SystemExit(f'{pid}：曲目页上没有乐谱')
    for link in links:
        name = os.path.join(dst, link.rsplit('/', 1)[1])
        with open(name, 'wb') as f:
            f.write(get(link))
        if name.endswith('.zip'):
            with zipfile.ZipFile(name) as z:
                for m in z.namelist():
                    target = os.path.realpath(os.path.join(dst, m))
                    if not target.startswith(os.path.realpath(dst) + os.sep):
                        raise SystemExit(f'{pid}：压缩包里有越界的路径 {m}')
                z.extractall(dst)
            os.remove(name)
    return info


def ly_files(d):
    return sorted(os.path.join(r, f) for r, _, fs in os.walk(d) for f in fs if f.endswith('.ly'))


def header(files):
    """从乐谱头里取授权、底本和编订者。"""
    text = '\n'.join(open(f, encoding='utf-8', errors='replace').read() for f in files)

    def field(*names):
        for n in names:
            m = re.search(rf'^\s*{n}\s*=\s*"([^"]*)"', text, re.M)
            if m:
                return m.group(1).strip()
        return ''

    return {'license': field('license', 'copyright'), 'source': field('source'), 'maintainer': field('maintainer')}


def block_end(s, open_at):
    """从 open_at 处的 { 开始找配对的 }，跳过注释和字符串。"""
    depth = 0
    i = open_at
    while i < len(s):
        c = s[i]
        if c == '%':
            if s[i:i + 2] == '%{':
                i = s.index('%}', i) + 2
                continue
            nl = s.find('\n', i)
            i = len(s) if nl < 0 else nl
            continue
        if c == '"':
            i += 1
            while s[i] != '"':
                i += 2 if s[i] == '\\' else 1
        elif c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise ValueError('括号不配对')


def patch_score(path, articulate):
    """给出 MIDI 的 \\score 加上 \\unfoldRepeats（第一、二结尾按顺序弹）和 \\articulate（断奏、装饰音）。"""
    s = open(path, encoding='utf-8').read()
    out, pos, changed = [], 0, 0
    for m in re.finditer(r'\\score\s*\{', s):
        if m.start() < pos:
            continue
        body = s[m.end():block_end(s, m.end() - 1)]
        if '\\midi' not in body:
            continue
        head = body.lstrip()
        add = '' if head.startswith('\\unfoldRepeats') else ' \\unfoldRepeats'
        if articulate and '\\articulate' not in head[:80]:
            add += ' \\articulate'
        out.append(s[pos:m.end()] + add)
        pos = m.end()
        changed += 1
    if not changed:
        raise SystemExit(f'{path}：没有找到出 MIDI 的 \\score')
    out.append(s[pos:])
    s = ''.join(out)
    if articulate and 'articulate.ly' not in s:
        s = re.sub(r'(\\version\s*"[^"]*"[^\n]*\n)', r'\1\\include "articulate.ly"\n', s, count=1)
    open(path, 'w', encoding='utf-8').write(s)


def engrave(src, work, mid, articulate):
    """升级乐谱、打补丁、导出 MIDI。articulate 出错时退回只展开反复。"""
    for attempt in ([True, False] if articulate else [False]):
        shutil.rmtree(work, ignore_errors=True)
        shutil.copytree(src, work)
        files = ly_files(work)
        for f in files:
            subprocess.run(['convert-ly', '-e', f], capture_output=True)
            s = open(f, encoding='utf-8').read()
            # 原谱为了 MIDI 好听把强弱去掉了：加回来
            s = re.sub(r'^.*\\remove\s*"?Dynamic_performer"?.*\n', '', s, flags=re.M)
            open(f, 'w', encoding='utf-8').write(s)
        mains = [f for f in files if re.search(r'\\score\s*\{', open(f, encoding='utf-8').read())]
        if len(mains) != 1:
            raise SystemExit(f'{src}：有 {len(mains)} 个文件里有 \\score，不知道用哪个')
        patch_score(mains[0], attempt)
        base = mid[: -len('.mid')]
        if os.path.exists(mid):
            os.remove(mid)
        # 有的老乐谱排版部分会报错（比如旧的自动连梁设置），MIDI 照样能出来
        subprocess.run(
            ['lilypond', '-dno-print-pages', '-dmidi-extension=mid', '--loglevel=ERROR', '-o', base, os.path.basename(mains[0])],
            cwd=os.path.dirname(mains[0]),
            capture_output=True,
        )
        if os.path.exists(mid) and os.path.getsize(mid) > 0:
            return attempt
    raise SystemExit(f'{src}：LilyPond 没有导出 MIDI')


def loudnorm_stats(path):
    p = run(['ffmpeg', '-hide_banner', '-i', path, '-af', f'loudnorm=I={TARGET_I}:TP={TARGET_TP}:LRA=20:print_format=json', '-f', 'null', '-'])
    err = p.stderr
    return json.loads(err[err.rindex('{'):err.rindex('}') + 1])


def render(mid, wav, dst, title, composer):
    run(['fluidsynth', '-ni', '-q', '-g', '0.5', '-r', '44100',
         '-o', 'synth.reverb.room-size=0.55', '-o', 'synth.reverb.damp=0.35', '-o', 'synth.reverb.width=0.9',
         '-o', 'synth.reverb.level=0.55', '-o', 'synth.chorus.active=0',
         '-F', wav, SF2, mid])
    s = loudnorm_stats(wav)
    af = (
        f"loudnorm=I={TARGET_I}:TP={TARGET_TP}:LRA=20:linear=true:"
        f"measured_I={s['input_i']}:measured_TP={s['input_tp']}:measured_LRA={s['input_lra']}:"
        f"measured_thresh={s['input_thresh']}:offset={s['target_offset']},"
        # 结尾的静音去掉，留一点余响；开头的静音也去掉
        "areverse,silenceremove=start_periods=1:start_threshold=-65dB:start_silence=1.5,areverse,"
        "silenceremove=start_periods=1:start_threshold=-65dB,aresample=48000"
    )
    run(['ffmpeg', '-hide_banner', '-y', '-i', wav, '-af', af, '-c:a', 'libopus', '-b:a', '64k', '-application', 'audio',
         '-metadata', f'title={title}', '-metadata', f'artist={composer}',
         '-metadata', 'comment=Public domain score from the Mutopia Project, rendered with FluidSynth and MuseScore General (MIT)',
         dst])
    return float(run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', dst]).stdout)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', default=os.path.join(REPO, '.bgm-cache'), help='下载和中间文件放哪里（默认仓库下的 .bgm-cache）')
    ap.add_argument('ids', nargs='*', help='只做这几首（默认全部）')
    a = ap.parse_args()
    for tool in ('lilypond', 'convert-ly', 'fluidsynth', 'ffmpeg', 'ffprobe'):
        if not shutil.which(tool):
            raise SystemExit(f'没有 {tool}')
    if not os.path.exists(SF2):
        raise SystemExit(f'没有音色库 {SF2}')
    pieces = json.load(open(os.path.join(HERE, 'pieces.json'), encoding='utf-8'))['pieces']
    manifest_path = os.path.join(OUT, 'manifest.json')
    old = {}
    if os.path.exists(manifest_path):
        old = {t['file']: t for t in json.load(open(manifest_path, encoding='utf-8')).get('tracks', [])}
    tracks = []
    for p in pieces:
        if a.ids and p['id'] not in a.ids:
            if p['file'] in old:
                tracks.append(old[p['file']])
            continue
        d = os.path.join(a.cache, p['id'])
        info = download(p['id'], os.path.join(d, 'src'))
        h = header(ly_files(os.path.join(d, 'src')))
        if h['license'].lower() != 'public domain':
            raise SystemExit(f"{p['id']}：乐谱的授权是「{h['license']}」，不是公有领域")
        used = engrave(os.path.join(d, 'src'), os.path.join(d, 'work'), os.path.join(d, 'score.mid'), p.get('articulate', True))
        note = humanize(os.path.join(d, 'score.mid'), os.path.join(d, 'play.mid'), p['pedal'], p['velocity'], p['tempo'])
        secs = render(os.path.join(d, 'play.mid'), os.path.join(d, 'play.wav'), os.path.join(OUT, p['file']), p['title'], p['composer'])
        os.remove(os.path.join(d, 'play.wav'))
        print(f"{p['id']} {p['file']}：{secs:.0f} 秒，{note}{'，articulate' if used else ''}")
        source = h['source'] if h['source'].lower() not in ('', 'unknown') else ''
        edition = '，'.join(x for x in (f'底本 {source}' if source else '', f"编订 {h['maintainer']}" if h['maintainer'] else '') if x)
        tracks.append({
            'file': p['file'],
            'title': p['title'],
            'composer': p['composer'],
            'mood': p['mood'],
            'source': info,
            'method': METHOD,
            'license': f"作品：公有领域；乐谱：Mutopia 标为公有领域（{edition}）；{SOUNDFONT_LICENSE}",
        })
    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump({'tracks': tracks}, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(f'写好了 {manifest_path}：{len(tracks)} 首')


if __name__ == '__main__':
    main()
