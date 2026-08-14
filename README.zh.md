# dsh-plugin-audiolib

[English](README.md) | 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的环境音轨插件：音乐由 agent 自己的状态驱动，曲库来自 [AudioLib.ai](https://audiolib.ai)——10 万首以上全版权清理的原创曲目，一次 API 调用换一首完整曲子。

agent 需要的状态信号本来就在会话事件流里：一个 turn 打开，说明它在干活；所有 turn 关闭，房间安静下来。这个插件把那条事件流变成声音。

**状态变化永远不打断正在播的曲子。** turn 的开合远比一首歌短，中途切歌听起来是噪音而不是反馈。曲子放完那一刻你处于什么状态，才决定下一首放什么。只有显式的 `music_stop` 会立刻停——要安静就得立刻安静。

## 安装

```sh
dsh plugin --profile web add dsh-plugin-audiolib
```

然后把 AudioLib 密钥放进环境变量（或写进下面的 `apiKey`），重启：

```sh
export AUDIOLIB_API_KEY=alp_your_key
```

密钥在 [audiolib.ai](https://audiolib.ai) 获取，免费额度每月 300 次。

播放依赖外部播放器：macOS 用系统自带的 `afplay`，其它平台用 `ffplay`（`brew install ffmpeg` / `apt install ffmpeg`）。想用别的播放器就改 `playerCommand`。

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
| `apiKey` | `''` | AudioLib 密钥；为空时回落到 `AUDIOLIB_API_KEY` |
| `baseUrl` | `https://api.audiolib.ai/v1/audio` | 音频接口地址 |
| `ambient` | `true` | 是否让会话事件驱动音轨 |
| `workingLibrary` | `audio.focus` | turn 打开期间播放的曲库；`''` 表示静音 |
| `idleLibrary` | `''` | 所有 turn 关闭后播放的曲库；`''` 表示静音 |
| `exposeTools` | `true` | 是否把 `music_play` / `music_stop` 给模型 |
| `playerCommand` | `[]` | 播放器 argv，用 `{file}` 占位；留空按平台取默认值 |
| `requestTimeoutMs` | `15000` | AudioLib 请求超时 |

已知曲库：`audio.focus`、`audio.ambient`、`audio.cinematic`、`audio.jazz`、`audio.sleep`、`audio.electronic`、`audio.default`。

## 工具

- `music_play(library)` — 让模型给自己的工作配乐。在下一个接缝处生效；当前没有播放时立即开始。
- `music_stop()` — 立刻停止，并保持静音直到再次调用 `music_play`。

两者都是 `ctx.tools` 上的普通注册，因此在 Code Mode 里也能直接 `await tools.music_play({ library })`。

## 实现方式

| 部分 | 扩展点 |
|---|---|
| 状态跟踪 | `ctx.on('session/event')` — 按会话计数 `turn/start` / `turn/end` |
| 模型控制 | `ctx.tools.register()`，原始 JSON Schema 定义 |
| 卸载清理 | `ctx.effect()` — 插件卸载即杀掉播放器并删除全部临时文件 |

每首曲子先下载到私有临时目录再播放，当前曲子播放期间预取下一首，所以接缝处没有空隙。AudioLib 调用很便宜，因状态变化而被丢弃的预取不值得优化。

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
