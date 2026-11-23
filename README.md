# Auto-ADV

全自动 AI 视觉小说 / 文字冒险的生成器与播放器（桌面应用）。

- **一键创世**：像在 Minecraft 里新建世界一样，一键生成世界观、角色、设定集、剧情、立绘、背景、BGM……每一项都可以选择自定义。
- **三种玩法**：和角色自由对话；带分支、存档、数值的剧情 ADV；或者只当观众，看 AI 角色们自己持续演下去（观察模式）。
- **模型可插拔**：OpenAI 兼容接口（DeepSeek、通义千问、Kimi、OpenAI、Ollama……）优先，之后加入 Claude、Gemini 原生接口，以及可选的生图、生视频、音乐和语音模型。
- **同人模式**：从已有作品学习，生成衍生世界。

> 当前进度：**M2 观察模式**已完成，**M3 剧情 ADV** 进行中（剧情图、VN 舞台和接 AI 已完成，观察模式切到 VN 舞台是下一步）。输入一句话（或者什么都不写），一键生成世界简报、世界观、角色、地点、剧情图（幕、岔路、数值和结局）、设定集和开场。然后可以：
> - **自由对话**：扮演主角和角色们聊天，可以重抽、切换分支、编辑、回退、存档读档，对话变长后会自动整理前情提要；
> - **观察模式**：只当观众，导演按剧情图一幕一幕安排每一拍，演员们自己演下去，像视觉小说一样逐字播放。你可以随时下导演指令、对某个角色说悄悄话、接管一个角色亲自演，或者暂停、调速、回退、重抽。有预算上限和安全阀，剧情图走到结局后会自动续写新篇章；
> - **剧情 ADV**：在 VN 舞台上按剧情图推进，每一拍由 AI 演出并给你几个选项（有的要掷骰检定），也可以直接输入想做的事；岔路由你决定，数值和检定由引擎裁决，走向不同的结局。手写了剧本的幕照剧本播放。

## 文档

- [架构设计](docs/ARCHITECTURE.md)
- [路线图](docs/ROADMAP.md)

## 下载试用（Windows）

每次推送后，GitHub Actions 会自动打一个 Windows 安装包：打开仓库的 **Actions** 页 → 最新一次 **CI** → 页面底部 **Artifacts** 里的 `Auto-ADV-Windows-Setup`。安装包还没有代码签名，首次运行时 Windows 可能提示"未知发布者"，选择"仍要运行"即可。

## 开发

需要 Node.js 22.18 或更新版本（推荐 24）和 pnpm 10。

```bash
pnpm install
pnpm dev          # 启动桌面应用（热更新）
pnpm test         # 单元测试
pnpm typecheck    # 类型检查
pnpm build        # 构建
pnpm dist:win     # 打 Windows 安装包，输出在 apps/desktop/release/
```

没有 API Key 时可以启动一个本地模拟服务来调试（它认得创世和对话请求，会返回固定的示例内容，能把整个流程走通）：

```bash
pnpm cli mock-server
# 然后在应用的 设置 → 模型接入点 里添加：Base URL 填 http://127.0.0.1:11435/v1，模型选 mock-chat
```

命令行也能直接测试真实的模型服务：

```bash
pnpm cli probe --base-url https://api.deepseek.com/v1 --key sk-... --model deepseek-chat
pnpm cli chat  --base-url https://api.deepseek.com/v1 --key sk-... --model deepseek-chat "你好"
# 不开界面跑一遍一键创世，打印生成的世界、调用次数和用量（调提示词用）
pnpm cli genesis --base-url https://api.deepseek.com/v1 --key sk-... --model deepseek-chat --probe "雾中的灯塔"
# 无人值守跑观察模式：生成世界后自动演 30 拍，打印质量报告（重复、停滞、剧情推进、用量），并写出带导演笔记的全文记录
pnpm cli observe --base-url https://api.deepseek.com/v1 --key sk-... --model deepseek-chat --beats 30 "雾中的灯塔"
pnpm cli observe --mock --beats 20     # 用内置模拟服务走一遍流程，不需要 API Key
```

生成的世界开始新周目时选「剧情 ADV」就能玩（需要配好模型）。也可以先玩手写的示例世界，不需要模型。在应用里：首页「导入世界」→ 选 `examples/worlds/old_library`（安装包自带，对话框默认打开那里）→「开始新周目」→「剧情 ADV」。也可以在命令行玩：

```bash
pnpm cli check-plot examples/worlds/old_library               # 剧情图的结构检查
pnpm cli adv examples/worlds/old_library                      # 在终端里从头玩到结局（每次是一个新周目）
pnpm cli adv examples/worlds/old_library --choose 1,1,2,1,3   # 按给定的选项走（这条是隐藏结局）
```

端到端测试会真正启动应用并走一遍完整流程（需要先 `pnpm build`；Linux 无显示环境用 `xvfb-run -a`）：

```bash
pnpm --filter @auto-adv/desktop e2e
```

### 代码结构

```
apps/desktop      Electron 应用：主进程、预加载脚本、引擎进程入口、React 界面
apps/cli          命令行工具
packages/schema   原生格式与设置的 Zod 定义
packages/providers 模型接入层：OpenAI 兼容客户端、能力探测、计费、模拟服务
packages/engine   核心引擎：模型网关、世界文件夹、创世管线、游玩运行时（事件树、记忆、观察模式的导演和演员）、剧情图（条件、结构检查、检定、手写剧本）、调用日志、RPC
examples/worlds   手写的示例世界（剧情图 + .adv 剧本）
```
