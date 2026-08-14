<p align="center">
  <img src="https://raw.githubusercontent.com/yangyue1974/dsh-plugin-audiolib/main/.github/assets/banner.jpg" alt="dsh-plugin-audiolib —— DeepSeek Harness 的环境音轨，由 AudioLib.ai 提供音乐" width="100%">
</p>

# dsh-plugin-audiolib

[English](README.md) | 中文

[![npm](https://img.shields.io/npm/v/dsh-plugin-audiolib.svg)](https://www.npmjs.com/package/dsh-plugin-audiolib)
[![ci](https://github.com/yangyue1974/dsh-plugin-audiolib/actions/workflows/ci.yml/badge.svg)](https://github.com/yangyue1974/dsh-plugin-audiolib/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-plugin-audiolib.svg)](LICENSE)


给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的环境音轨插件：音乐由 agent 自己的状态驱动，曲库来自 [AudioLib.ai](https://audiolib.ai)——10 万首以上全版权清理的原创曲目，一次 API 调用换一首完整曲子。

agent 需要的状态信号本来就在会话事件流里：一个 turn 打开，说明它在干活；所有 turn 关闭，房间安静下来。这个插件把那条事件流变成声音。

**状态变化永远不打断正在播的曲子。** turn 的开合远比一首歌短，中途切歌听起来是噪音而不是反馈。曲子放完那一刻你处于什么状态，才决定下一首放什么。只有显式的 `music_stop` 会立刻停——要安静就得立刻安静。

## 安装

如果你是用 `npx @deepseek-ai/dsh web` 装的 DSH——不装全局包，CLI 就活在 profile 里——那 `dsh` 根本不在 `PATH` 上，直接敲 `dsh` 只会得到 command not found。改用 `npx` 调用它，并且先启用 pnpm：DSH 用 pnpm 管理 profile 插件，没装就直接拒绝。

```sh
corepack enable pnpm
npx @deepseek-ai/dsh plugin --profile web add dsh-plugin-audiolib
```

corepack 随 Node 自带，这一步不会引入任何第三方全局安装，`corepack disable pnpm` 也能随时撤销。要是你的 `PATH` 上本来就有 `dsh`，直接 `dsh plugin --profile web add dsh-plugin-audiolib` 效果一样。

重启——`npx @deepseek-ai/dsh web`——之后打开 **设置 → 插件 → 插件配置**，在 **AudioLib 环境音轨** 卡片里粘贴密钥，保存即可——密钥存进 DSH 的凭据库（`~/.dsh/.credentials.yaml`，权限 600），不进任何配置文件，也不用重启。

密钥在 [audiolib.ai](https://audiolib.ai) 获取，免费额度每月 300 次。

不想用界面的话，环境变量同样有效：

```sh
export AUDIOLIB_API_KEY=alp_your_key
```

### 播放

曲子是**流式播放**的：缓冲到第一批字节就出声，这也是 AudioLib 的 URL 本来的用法。这需要一个能直接吃 URL 的播放器——`mpv` 或 `ffplay`，装哪个都行：

```sh
brew install mpv        # 或：apt install mpv
```

都没有时，插件回落到 macOS 自带的 `afplay`。它只能读本地文件，于是插件会提前把整首下载下来——能用，但每首要花掉几 MB，中途换曲库时还会卡住等下载。建议装一个流式播放器。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖这一行：

```yaml
- id: audiolib
  name: dsh-plugin-audiolib
  config:
    workingLibrary: audio.focus
    idleLibrary: audio.ambient
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKeyRef` | `AUDIOLIB_API_KEY` | 存放密钥的凭据名——只是引用，密钥本身不写在这里 |
| `baseUrl` | `https://api.audiolib.ai/v1/audio` | 音频接口地址 |
| `ambient` | `true` | 是否让会话事件驱动音轨 |
| `workingLibrary` | `audio.focus` | turn 打开期间播放的曲库；`''` 表示静音 |
| `idleLibrary` | `''` | 所有 turn 关闭后播放的曲库；`''` 表示静音 |
| `exposeTools` | `true` | 是否把 `music_play` / `music_stop` / `music_status` 给模型 |
| `playerCommand` | `[]` | 播放器 argv；留空自动选。`{url}` 声明流式播放器，`{file}` 声明只读本地文件的 |
| `requestTimeoutMs` | `15000` | AudioLib 请求超时 |

曲库共 25 个——`audio.focus`、`audio.ambient`、`audio.cinematic`、`audio.jazz`、`audio.classical`、`audio.sleep`、`audio.meditation`、`audio.workout`、`audio.electronic` 等。API 认的 id 都能用；完整列表在 `src/libraries.ts`，也写进了 `music_play` 的工具描述。

## 工具

- `music_play(library)` — 让模型给自己的工作配乐。在下一个接缝处生效；当前没有播放时立即开始。
- `music_stop()` — 立刻停止，并保持静音直到再次调用 `music_play`。
- `music_status()` — 报告正在播放的曲目，以及 AudioLib 的套餐、剩余调用次数和速率上限。配额搭在每次取曲的响应里返回，所以这个查询不花调用额度。

两者都是 `ctx.tools` 上的普通注册，因此在 Code Mode 里也能直接 `await tools.music_play({ library })`。

`music_play` 选的曲库只活到这段工作结束：最后一个 turn 关闭时，音轨回到 `idleLibrary`。明确选的曲库，是为它配的那段工作而选的。

请求失败时，瞬时原因——网络、5xx、超时、速率限制——会退避重试且不设上限，音乐自己接上。密钥错误、额度耗尽、播放器缺失、响应读不了则转为暂停；`music_status` 会说是哪一种，其中额度暂停在周期翻转后自行解除。

## 实现方式

| 部分 | 扩展点 |
|---|---|
| 状态跟踪 | `ctx.on('session/event')` — 按会话计数 `turn/start` / `turn/end` |
| 模型控制 | `ctx.tools.register()`，原始 JSON Schema 定义 |
| 卸载清理 | `ctx.effect()` — 插件卸载即杀掉播放器并删除全部临时文件 |

`playerCommand` 里的占位符决定播放模式。`{url}` 把 AudioLib 的 URL 直接交给播放器，边播边缓冲——不落盘，API 一返回就出声。`{file}` 表示播放器不能流式，插件才会先把曲子下载到私有临时目录，播完删除。

两种模式都会提前取好下一首：插件加载时取一首，让第一个 turn 一开就有声；每首开始播时再取下一首，接缝处没有空隙。AudioLib 调用很便宜，因状态变化被丢弃的预取不值得优化。

## 开发

```sh
npm install
npm run build
```

不安装、直接把源码 checkout 挂进运行中的 harness：

```yaml
# audiolib.overlay.yml
- insert:
    - id: audiolib
      name: '/absolute/path/to/dsh-plugin-audiolib/lib/index.js'
      config:
        workingLibrary: audio.focus
```

```sh
dsh web --patch ./audiolib.overlay.yml
```

## 许可

MIT
