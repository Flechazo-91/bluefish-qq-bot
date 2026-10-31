# BlueFish · 蓝色大肥鱼 QQ 机器人

一套跑在 Windows 本机上的 QQ 机器人：会聊天、会唱歌、会点歌、会画画、会报课表，
自己还会去抖音刷视频发作品、在 B 站做切片。

> 这不是一个"调 API 的聊天壳"。人设、声音、唱歌换声、视频理解、自动化任务
> 都在你自己的电脑上跑，数据不出门。

---

## 它能做什么

| 模块 | 能力 |
|---|---|
| **聊天** | DeepSeek 对话 + 本地知识库长期记忆（人设/好友画像/群设定）+ 群聊上下文 + 8% 主动接话 |
| **语音** | GPT-SoVITS 自己的音色说话；Whisper 本地识别语音消息 |
| **唱歌** | 搜歌 → 15 秒副歌 → Demucs 分人声 → Seed-VC 换成她的音色；朗读版自动跳过 |
| **点歌** | 网易云 320k 直链 → 40 秒副歌（会员曲自动换版本） |
| **画画** | 通义万相 wanx2.1-t2i-turbo |
| **视频** | 私聊短视频：九宫格关键帧 + VLM 描述 + 音轨转写 |
| **课表** | 早报 7:30、课前提醒、按真实日期现算（不会串周） |
| **表情包** | 语义检索，按语境自动配图 |
| **抖音** | 定时刷推荐流 + 自动发图文/视频（TTS 配音 + AI 配图 + 硬字幕） |
| **B 站** | 定时切片上传（依赖 bili-whale） |
| **提醒** | 打卡提醒（@全体）、睡眠话术、跨项目 QQ 通知接口 |

## 架构

```
QQ 客户端
   │
SnowLuma (QQ NT 桥, OneBot v11)
   │  ws://127.0.0.1:6199/ws
AstrBot (对话内核 + 插件)
   ├─ plugins/  ← 本项目提供：sing / music / img_gen / sleep_mode / timetable_context / video_reader
   ├─ 本地服务：GPT-SoVITS(9880) Whisper(8000) Embedding(8100)
   └─ 工具：tools/（课表、通知、唱歌、群画像）+ douyin/（抖音自动化）
```

## 目录

```
plugins/            AstrBot 插件（放进 AstrBot/data/plugins/）
tools/              独立命令行工具
  notify-qq.mjs      任何脚本跑完给她发 QQ
  timetable.mjs      课表早报/课前提醒/写知识库
  sing_for.mjs       一键给别人唱一首
  group-profiles.mjs 群成员/活跃好友画像 → 知识库
  checkin-remind.mjs 打卡提醒
douyin/             抖音自动化（Edge + CDP，不装 Playwright）
launcher/           桌面控制台（环境自检/配置/启停/日志）+ 安装脚本
configs/            配置示例（全部为占位值）
docs/               功能总览
```

## 快速开始

1. 装 [AstrBot](https://github.com/AstrBotDevs/AstrBot) 和 [SnowLuma](https://github.com/SnowLuma/SnowLuma)（QQ 桥）
2. 把 `plugins/*` 复制到 `AstrBot/data/plugins/`
3. 填配置：`configs/cmd_config.example.json` 为模板，需要
   - DeepSeek API Key
   - OneBot token（SnowLuma 那边生成）
4. 想要语音/唱歌：装 GPT-SoVITS（参考音 `refs/`）和 Seed-VC（F0 44k 歌声模型）
5. 启停：`launcher/` 里有图形控制台和脚本

Windows 用户也可以直接用离线包（自行打包：便携 Python + Node + 依赖）。

## 配置（环境变量）

所有脚本都从环境变量读，不再硬编码：

| 变量 | 用途 |
|---|---|
| `ONEBOT_HOST` | OneBot HTTP 地址，默认 `http://127.0.0.1:3000/` |
| `ONEBOT_TOKEN` | OneBot 访问令牌 |
| `BF_HOME` | AstrBot 数据目录（默认 `D:\AstrBot`） |
| `BF_KB_JWT_SECRET` | AstrBot WebUI 的 JWT 密钥（脚本写知识库时用） |
| `SNOWLUMA_HOME` | SnowLuma 目录 |

## 已知限制

- 只支持 Windows（QQ 客户端与计划任务）
- 唱歌/本地 TTS 需要 NVIDIA 显卡（6 GB+）；无卡时自动退化为纯文字
- 抖音自动化依赖登录态（独立 Edge profile），首次需扫码
- 会员曲受网易云版权限制，拿不到时自动换版本

## 许可证

MIT，见 [LICENSE](LICENSE)。

## 免责声明

第三方 QQ 客户端桥接属于平台灰色地带，请使用小号、控制频率、遵守平台规则。
本项目仅用于个人学习与自用，使用风险自负。

## 路径与配置说明

代码里的默认路径是 `D:/AstrBot`（AstrBot 数据目录）和 `D:/SnowLuma`（SnowLuma 目录）。
装到别处时，全局替换这两个前缀即可，或设置环境变量后改对应常量：

```powershell
# 推荐：AstrBot 装到别的盘
$env:BF_HOME = "E:/AstrBot"
```

需要自己准备的密钥（**不要把真实值提交进仓库**）：

| 用途 | 位置 |
|---|---|
| DeepSeek API Key | AstrBot WebUI → 服务提供商，或 `configs/cmd_config.example.json` 的 `provider_sources[].key` |
| OneBot token | SnowLuma 配置生成的 `accessToken`，脚本侧用 `ONEBOT_TOKEN` |
| 网易云 Cookie | `D:/AstrBot/netease.cookie`（格式 `MUSIC_U xxx` 每行一条） |
| AstrBot JWT secret | `BF_KB_JWT_SECRET`（脚本写知识库时用） |

## 发布到 GitHub

`publish.ps1` 用 GitHub REST API 直接建仓库并上传（不需要装 git，适合 `github.com` 直连不通但 `api.github.com` 可达的情况）：

```powershell
$env:GITHUB_TOKEN = "ghp_xxx"     # classic token 勾 repo；或 fine-grained: Contents R/W + Administration W
powershell -ExecutionPolicy Bypass -File publish.ps1 -RepoName bluefish-qq-bot
```

先用 `-DryRun` 看会传哪些文件。
