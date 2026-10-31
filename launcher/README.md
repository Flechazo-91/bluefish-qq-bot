# 蓝色大肥鱼 · BlueFish Studio

一个 Windows 桌面控制台，把 QQ 机器人「一只蓝色大肥鱼qwq」的整套能力打包成可视化工具：
环境自检、账号配置、一键启停、日志查看。

## 快速开始

1. 看 `安装教程.md`（30 分钟，主要时间在装 Python/Node 和放模型）
2. 双击 `启动.vbs`（或桌面「蓝色大肥鱼」）
3. ① 环境自检 → ② 填 QQ 小号 + DeepSeek Key → ③ 一键启动 → SnowLuma 里扫码

## 目录

```
BlueFishStudio\
  app.py            控制台（Tkinter）
  启动.vbs          无窗口启动
  调试启动.bat       带控制台启动（看报错用）
  profile.json      你的配置（QQ/Key/Cookie，勿外传）
  scripts\
    install.ps1      环境安装（uv/AstrBot/快捷方式）
    apply-config.ps1 把 profile 写进 AstrBot / SnowLuma 配置
    start-all.ps1    一键启动全部服务
    stop-all.ps1     一键停止
  logs\             控制台与启动日志
  安装教程.md / 使用教程.md
```

## 依赖的目录（放在同级或用现有安装）

- `AstrBot\`（AstrBot 本体；默认会找 `D:/AstrBot`）
- `SnowLuma\app\`（QQ 桥；默认会找 `D:/SnowLuma`）
- `Models\GPT-SoVITS\`、`Models\seed-vc\`（可选，语音/唱歌）

## 说明

- 所有配置**只写本机**，不上传任何服务器
- 控制台只用系统 Python 的 tkinter，不需要额外依赖
- 没有 GPU 也能用：聊天/画画/点歌可用，她自己的声音和唱歌需要 NVIDIA 显卡