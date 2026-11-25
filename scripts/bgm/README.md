# 内置曲库的做法

`resources/bgm/` 里的曲子都是用这里的脚本从公有领域乐谱渲染出来的（ARCHITECTURE.md 18.7）。改曲目、加曲目时改 `pieces.json`，再跑一遍：

```sh
python3 scripts/bgm/build.py            # 全部重做
python3 scripts/bgm/build.py 37 504     # 只重做这两首（其余曲目在清单里的条目不变）
```

下载的乐谱和中间文件放在仓库下的 `.bgm-cache/`（已忽略），`--cache` 可以换地方。

## 需要的东西

- LilyPond 2.24（`convert-ly` 一起装上）
- FluidSynth
- ffmpeg（要有 libopus）
- MuseScore General 音色库：Debian / Ubuntu 上装 `musescore-general-soundfont-lossless`，文件在 `/usr/share/sounds/sf2/MuseScore_General_Full.sf2`
- 能访问 www.mutopiaproject.org

## 每首怎么做

1. 从 Mutopia 下载 LilyPond 乐谱。乐谱头里的 `license`（或 `copyright`）必须是 `Public Domain`，不是就停下。Mutopia 上很多曲目是 CC BY-SA，不能放进来。
2. `convert-ly` 升级到本机的 LilyPond；去掉乐谱里"MIDI 不要强弱"的设置；给出 MIDI 的 `\score` 加上 `\unfoldRepeats`（反复和第一、二结尾按顺序弹）和 `\articulate`（断奏、装饰音）。`articulate` 出错时退回只展开反复。
3. `midi.py` 调整：
   - `tempo`：速度倍数。有的乐谱没写速度（LilyPond 默认每分钟 60 拍），或者写得比常见演奏快很多。
   - `velocity`：力度中位数。乐谱里写的强弱保留相对关系；同时按下的几个音里最高的稍重。
   - `pedal`：乐谱里有踏板记号就用 `keep`；没有的按 `bar`（每小节）、`half`（每半小节）、`beat`（每拍）补，快的曲子用 `none`。
4. FluidSynth 渲染（加一点混响），ffmpeg 两遍 `loudnorm` 把响度统一到 -20 LUFS（线性，不压动态），去掉开头结尾的静音，压成 Opus 64 kbps。
5. 写 `resources/bgm/manifest.json`：曲名、作曲家、情绪、曲目页链接、做法和授权，「设置 → 关于」按它列出来。

## 授权

- 作品：作曲家都已去世超过 70 年，作品是公有领域。
- 乐谱：Mutopia 上标为 Public Domain 的版本（编订者放弃了权利），底本和编订者写在清单的授权里。
- 音色库：MuseScore General，MIT 授权；钢琴是公有领域的采样。渲染出来的音频不受音色库授权的限制。
