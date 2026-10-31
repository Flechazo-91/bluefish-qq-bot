# 准备工作清单（你需要提供什么）

按这个顺序准备，全部弄完大约 **40 分钟**（不含下载模型）。

---

## 一、必须有

### 1. QQ 小号

| 项 | 说明 |
|---|---|
| 为什么必须 | 机器人要挂在 QQ 客户端上，通过 SnowLuma 接管收发消息 |
| 怎么准备 | 注册一个新的 QQ 号，**不要用主号**（有风控/冻结风险） |
| 需要提供 | QQ 号；登录方式（手机扫码 / 密码） |
| 填在哪 | 控制台 ② 页「QQ 小号」；或 `launcher/scripts/apply-config.ps1` 生成的 `onebot_<QQ>.json` |
| 注意 | 小号需要能正常登录，并且**手机 QQ 要在身边**（扫码时要确认） |

### 2. DeepSeek API Key

| 项 | 说明 |
|---|---|
| 为什么必须 | 所有对话、写文案、出图提示词都走它 |
| 怎么准备 | https://platform.deepseek.com/api_keys → 登录 → 创建 API Key → 复制 `sk-` 开头那串 |
| 需要提供 | `sk-xxxxxxxx` |
| 填在哪 | 控制台 ② 页「DeepSeek Key」；或 `cmd_config.json` 的 `provider_sources[].key` |
| 费用 | 按量计费，日常聊天约 ¥0.5~2/天（视消息量） |

---

## 二、想要完整功能才需要

### 3. 网易云 Cookie（点歌 / 唱歌）

| 项 | 说明 |
|---|---|
| 为什么 | 320k 直链需要登录态；没 Cookie 只能拿免费曲，会员曲会失败 |
| 怎么准备 | 浏览器登录 music.163.com → F12 → Application → Cookies → 复制 `MUSIC_U` 和 `__csrf` |
| 需要提供 | `MUSIC_U=xxxx; __csrf=yyyy`（脚本会自动转成插件要的「键 空格 值」格式） |
| 填在哪 | 控制台 ② 页「网易云 Cookie」，会写到 `D:/AstrBot/netease.cookie` |
| 有效期 | 约 2~3 个月，过期重新复制 |

### 4. 语音 / 唱歌模型（13 GB）

| 模型 | 用途 | 放哪 |
|---|---|---|
| **GPT-SoVITS**（含 `runtime/` 与 `GPT_SoVITS/pretrained_models`） | 用她的音色说话 | `Models/GPT-SoVITS/` |
| 参考音（5~10 秒干净人声 wav） | 决定她"是谁的声音" | GPT-SoVITS 的 `refs/`，改 `REF_AUDIO` 常量 |
| **Seed-VC**（`checkpoints/DiT_seed_v2_uvit_whisper_base_f0_44k_*.pth`） | 唱歌换声 | `Models/seed-vc/` |
| Demucs `htdemucs` | 分离人声/伴奏 | 首次运行自动下载（约 80 MB） |
| Whisper small | 听懂语音消息 | 首次运行自动下载（约 480 MB） |

> 没有这些也能用：聊天、画画、点歌、课表、提醒、表情包全部正常，只是没有"她自己的声音"和唱歌。

### 5. NVIDIA 显卡（6 GB 显存以上）

| 项 | 说明 |
|---|---|
| 为什么 | TTS / 唱歌换声 / Demucs 都要 CUDA |
| 没有会怎样 | 自动退化为纯文字；模型放了也跑不动 |

### 6. 抖音登录（抖音自动化）

| 项 | 说明 |
|---|---|
| 为什么 | 刷视频/发作品需要登录态（独立 Edge profile，登录一次长期有效） |
| 怎么准备 | 启动后在自带 Edge 窗口里扫码；二维码**必须在抖音 App 内扫**，微信/相机扫只会打开网页 |
| 需要提供 | 抖音账号（手机扫码） |

### 7. 目标 QQ 号 / 群号（可选配置）

| 用途 | 填在哪 |
|---|---|
| 课表收件人、提醒对象 | `AstrBot/timetable.json` 的 `recipients: [QQ号]` |
| 打卡提醒的群 | `tools/checkin-remind.mjs` 的 `group` 默认值 |
| 管理员（可用 slash 命令） | `cmd_config.json` 的 `admins_id: [QQ号]` |

---

## 三、填进去之前先确认

| 检查 | 命令 / 位置 | 期望 |
|---|---|---|
| 端口没被占用 | `netstat -ano \| findstr "3000 6185 5099"` | 无输出 |
| Python 3.12 | `python --version` | 3.12.x |
| Node 20 | `node -v` | v20.x |
| 显卡可用 | `nvidia-smi` | 能打出显卡型号（没有就跳过） |
| 目录结构 | 控制台 ① 页自检 | AstrBot / SnowLuma 目录 ✅ |

---

## 四、一句话总结

**最小可用**：QQ 小号 + DeepSeek Key（5 分钟配完，能聊天）。
**完整功能**：再加 网易云 Cookie + 13 GB 语音模型 + NVIDIA 显卡 + 抖音扫码。
