#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""蓝色大肥鱼 · 桌面控制台（BlueFish Studio）

一个给"非技术用户"用的图形外壳：
  · 第一次打开 → 环境自检 → 填 QQ 小号 + 认证信息 → 一键安装/启动
  · 之后每次打开 → 看状态、启停、看日志
不依赖 AstrBot 的 python 环境，用系统自带的 python 跑（tkinter）。

用法：
  python app.py            正常打开界面
  python app.py --selftest 只跑自检并把结果打印出来（命令行模式，供安装脚本调用）
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

APP_NAME = "BlueFish Studio · 蓝色大肥鱼控制台"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)          # 安装根目录
PROFILE = os.path.join(HERE, "profile.json")
LOGDIR = os.path.join(HERE, "logs")
def _resolve_home(name: str, fallback: str, profile: dict | None = None) -> str:
    """找 AstrBot / SnowLuma：profile 指定 > 安装目录同级 > 本机默认 > 用户目录。"""
    cands = []
    if profile:
        cands.append(profile.get(name.lower() + "_home") or "")
    cands += [
        os.path.join(ROOT, name),
        os.path.join(os.path.dirname(ROOT), name),
        fallback,
        os.path.join(os.path.expanduser("~"), name),
    ]
    for c in cands:
        if c and os.path.isdir(c):
            return os.path.abspath(c)
    return os.path.join(ROOT, name)


ASTRBOT_HOME = _resolve_home("AstrBot", r"D:\AstrBot")
SNOWLUMA_HOME = _resolve_home("SnowLuma", r"D:\SnowLuma")

DEFAULTS = {
    "qq": "",
    "auth_mode": "qrcode",            # qrcode | password | sms
    "qq_password": "",
    "deepseek_key": "",
    "deepseek_base": "https://api.deepseek.com/v1",
    "netease_cookie": "",
    "onebot_port": 3000,
    "onebot_token": "",
    "enable_sing": True,
    "enable_music": True,
    "enable_douyin": False,
    "astrbot_home": "",
    "snowluma_home": "",
}

C = {
    "bg": "#0f1720", "panel": "#17222e", "ink": "#e8f1f8", "dim": "#8fa6b8",
    "accent": "#3fb6ff", "ok": "#38d39f", "warn": "#f0b429", "bad": "#ff6b6b",
}


def load_profile() -> dict:
    data = dict(DEFAULTS)
    try:
        with open(PROFILE, encoding="utf-8") as f:
            data.update(json.load(f))
    except Exception:
        pass
    return data


def save_profile(data: dict) -> None:
    with open(PROFILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def find_python() -> str:
    for cand in (os.path.join(ROOT, "python", "python.exe"), sys.executable,
                 r"C:\Users\ruanr\AppData\Roaming\uv\tools\astrbot\Scripts\python.exe"):
        if cand and os.path.exists(cand):
            return cand
    return "python"


def port_open(port: int, host: str = "127.0.0.1") -> bool:
    import socket
    s = socket.socket()
    s.settimeout(0.6)
    try:
        return s.connect_ex((host, port)) == 0
    finally:
        s.close()


def run_ps(script: str, timeout: int = 600, capture: bool = True) -> tuple[int, str]:
    exe = shutil.which("powershell") or "powershell.exe"
    cmd = [exe, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script]
    try:
        r = subprocess.run(cmd, capture_output=capture, text=True, timeout=timeout,
                           encoding="utf-8", errors="replace")
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except subprocess.TimeoutExpired:
        return 124, "超时"
    except Exception as e:                      # noqa: BLE001
        return 1, str(e)


# --------------------------------------------------------------------------- checks
def run_checks(profile: dict) -> list[tuple[str, str, str]]:
    """返回 [(名称, 状态 ok/warn/bad, 说明)]"""
    out: list[tuple[str, str, str]] = []

    # 1 系统
    if sys.platform.startswith("win"):
        out.append(("操作系统", "ok", f"Windows（{sys.getwindowsversion().major}.{sys.getwindowsversion().minor}）"))
    else:
        out.append(("操作系统", "bad", "只支持 Windows（QQ 客户端 + 计划任务依赖）"))

    # 2 python
    out.append(("Python", "ok" if sys.version_info >= (3, 10) else "warn", sys.version.split()[0]))

    # 3 node
    node = shutil.which("node")
    if node:
        try:
            v = subprocess.run([node, "-v"], capture_output=True, text=True, timeout=5).stdout.strip()
            out.append(("Node.js", "ok", v))
        except Exception:
            out.append(("Node.js", "warn", "有 node 但读不到版本"))
    else:
        out.append(("Node.js", "warn", "没找到（SnowLuma 需要 Node 18+，安装脚本会装）"))

    # 4 GPU
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
                           capture_output=True, text=True, timeout=8)
        if r.returncode == 0 and r.stdout.strip():
            out.append(("NVIDIA 显卡", "ok", r.stdout.strip().splitlines()[0]))
        else:
            out.append(("NVIDIA 显卡", "warn", "没识别到，语音/唱歌会退化为纯文字"))
    except Exception:
        out.append(("NVIDIA 显卡", "warn", "没装 nvidia-smi（无 GPU 也能聊，只是没有语音/唱歌）"))

    # 5 目录结构
    for name, path in (("AstrBot", ASTRBOT_HOME), ("SnowLuma", SNOWLUMA_HOME)):
        out.append((f"{name} 目录", "ok" if os.path.isdir(path) else "bad",
                    path if os.path.isdir(path) else f"缺少 {path}（先跑安装脚本）"))

    # 6 端口
    ports = [(profile.get("onebot_port", 3000), "OneBot"),
             (6185, "AstrBot WebUI"),
             (5099, "SnowLuma WebUI")]
    for port, label in ports:
        out.append((f"端口 {port}（{label}）", "ok" if port_open(int(port)) else "warn",
                    "已在监听" if port_open(int(port)) else "未监听（还没启动）"))

    # 7 配置
    key_ok = bool((profile.get("deepseek_key") or "").strip())
    out.append(("DeepSeek API Key", "ok" if key_ok else "bad",
                "已填写" if key_ok else "没填，聊天功能不可用"))
    qq_ok = bool(str(profile.get("qq") or "").strip())
    out.append(("QQ 小号", "ok" if qq_ok else "bad",
                f"已填 {profile['qq']}" if qq_ok else "没填"))

    return out


# --------------------------------------------------------------------------- gui
class App(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.profile = load_profile()
        os.makedirs(LOGDIR, exist_ok=True)
        self.title(APP_NAME)
        self.geometry("980x680")
        self.configure(bg=C["bg"])
        self.minsize(900, 620)
        self._build_style()
        self._build_ui()
        self.after(300, self.refresh_status)
        self.after(600, self.refresh_checks)   # 打开就自动跑一次自检

    # ---- 样式
    def _build_style(self) -> None:
        st = ttk.Style(self)
        try:
            st.theme_use("clam")
        except Exception:
            pass
        st.configure(".", background=C["bg"], foreground=C["ink"], font=("Microsoft YaHei UI", 10))
        st.configure("TFrame", background=C["bg"])
        st.configure("Panel.TFrame", background=C["panel"])
        st.configure("TLabel", background=C["bg"], foreground=C["ink"])
        st.configure("Panel.TLabel", background=C["panel"], foreground=C["ink"])
        st.configure("Dim.TLabel", background=C["bg"], foreground=C["dim"])
        st.configure("Title.TLabel", background=C["bg"], foreground=C["accent"],
                     font=("Microsoft YaHei UI", 16, "bold"))
        # 输入框：深色底 + 浅色字（默认 ttk 是白底，浅色字会看不见）
        st.configure("TEntry", fieldbackground="#0b1219", foreground=C["ink"],
                     insertcolor=C["ink"], bordercolor=C["accent"], lightcolor=C["accent"], darkcolor=C["accent"])
        st.map("TEntry", fieldbackground=[("readonly", "#0b1219")], foreground=[("disabled", C["dim"])])
        st.configure("TButton", padding=(12, 6))
        st.configure("Accent.TButton", background=C["accent"], foreground="#06121c", padding=(14, 7))
        st.configure("TNotebook", background=C["bg"], borderwidth=0)
        st.configure("TNotebook.Tab", padding=(18, 8), background=C["panel"], foreground=C["ink"])
        st.map("TNotebook.Tab", background=[("selected", C["accent"])], foreground=[("selected", "#06121c")])
        st.configure("Treeview", background=C["panel"], fieldbackground=C["panel"], foreground=C["ink"], rowheight=26)
        st.configure("Treeview.Heading", background=C["bg"], foreground=C["accent"])

    # ---- 布局
    def _build_ui(self) -> None:
        head = ttk.Frame(self)
        head.pack(fill="x", padx=18, pady=(16, 6))
        ttk.Label(head, text="🐳 蓝色大肥鱼 · 控制台", style="Title.TLabel").pack(side="left")
        self.lbl_clock = ttk.Label(head, text="", style="Dim.TLabel")
        self.lbl_clock.pack(side="right")

        nb = ttk.Notebook(self)
        self.nb = nb
        nb.pack(fill="both", expand=True, padx=14, pady=8)

        self.tab_check = ttk.Frame(nb)
        self.tab_cfg = ttk.Frame(nb)
        self.tab_run = ttk.Frame(nb)
        self.tab_log = ttk.Frame(nb)
        nb.add(self.tab_check, text="① 环境自检")
        nb.add(self.tab_cfg, text="② 账号与认证")
        nb.add(self.tab_run, text="③ 启动 / 状态")
        nb.add(self.tab_log, text="④ 日志")

        self._build_check()
        self._build_cfg()
        self._build_run()
        self._build_log()

    def _build_check(self) -> None:
        top = ttk.Frame(self.tab_check)
        top.pack(fill="x", pady=10, padx=10)
        ttk.Label(top, text="点一下检查这台机器能不能跑起来。红色必须解决，黄色可以先用（功能会少）。",
                  style="Dim.TLabel").pack(side="left")
        ttk.Button(top, text="重新检查", command=self.refresh_checks).pack(side="right")

        cols = ("item", "state", "detail")
        self.tree = ttk.Treeview(self.tab_check, columns=cols, show="headings", height=16)
        for c, t, w in (("item", "检查项", 220), ("state", "结果", 90), ("detail", "说明", 600)):
            self.tree.heading(c, text=t)
            self.tree.column(c, width=w, anchor="w")
        self.tree.pack(fill="both", expand=True, padx=10, pady=(0, 10))
        self.tree.tag_configure("ok", foreground=C["ok"])
        self.tree.tag_configure("warn", foreground=C["warn"])
        self.tree.tag_configure("bad", foreground=C["bad"])

        self.lbl_check_sum = ttk.Label(self.tab_check, text="", style="Dim.TLabel")
        self.lbl_check_sum.pack(pady=(0, 10))

    def _build_cfg(self) -> None:
        wrap = ttk.Frame(self.tab_cfg)
        wrap.pack(fill="both", expand=True, padx=16, pady=12)

        def row(label: str, hint: str = ""):
            f = ttk.Frame(wrap)
            f.pack(fill="x", pady=6)
            ttk.Label(f, text=label, width=18).pack(side="left")
            return f

        f = row("QQ 小号")
        self.var_qq = tk.StringVar(value=str(self.profile.get("qq", "")))
        ttk.Entry(f, textvariable=self.var_qq, width=28).pack(side="left")

        f = row("登录方式")
        self.var_auth = tk.StringVar(value=self.profile.get("auth_mode", "qrcode"))
        ttk.Radiobutton(f, text="手机扫码（推荐）", value="qrcode", variable=self.var_auth).pack(side="left")
        ttk.Radiobutton(f, text="QQ 密码", value="password", variable=self.var_auth).pack(side="left", padx=8)
        ttk.Radiobutton(f, text="短信验证码", value="sms", variable=self.var_auth).pack(side="left")

        f = row("QQ 密码（可选）")
        self.var_pwd = tk.StringVar(value=self.profile.get("qq_password", ""))
        ttk.Entry(f, textvariable=self.var_pwd, width=28, show="*").pack(side="left")
        ttk.Label(f, text="只存在本机 profile.json，不上传", style="Dim.TLabel").pack(side="left", padx=8)

        f = row("DeepSeek Key")
        self.var_key = tk.StringVar(value=self.profile.get("deepseek_key", ""))
        ttk.Entry(f, textvariable=self.var_key, width=52).pack(side="left")
        ttk.Button(f, text="怎么申请？", command=lambda: messagebox.showinfo(
            "DeepSeek API Key",
            "打开 https://platform.deepseek.com/api_keys 登录后点「创建 API Key」，\n"
            "复制 sk- 开头那串填进来即可。\n按量计费，日常聊天很便宜。")).pack(side="left", padx=8)

        f = row("网易云 Cookie")
        self.var_cookie = tk.StringVar(value=self.profile.get("netease_cookie", ""))
        ttk.Entry(f, textvariable=self.var_cookie, width=52).pack(side="left")
        ttk.Label(f, text="可选：填了才能点歌/唱歌", style="Dim.TLabel").pack(side="left", padx=8)

        f = row("OneBot 端口")
        self.var_port = tk.StringVar(value=str(self.profile.get("onebot_port", 3000)))
        ttk.Entry(f, textvariable=self.var_port, width=10).pack(side="left")
        ttk.Label(f, text="默认 3000，被占用就换", style="Dim.TLabel").pack(side="left", padx=8)

        f = row("功能开关")
        self.var_sing = tk.BooleanVar(value=bool(self.profile.get("enable_sing", True)))
        self.var_music = tk.BooleanVar(value=bool(self.profile.get("enable_music", True)))
        self.var_douyin = tk.BooleanVar(value=bool(self.profile.get("enable_douyin", False)))
        ttk.Checkbutton(f, text="唱歌", variable=self.var_sing).pack(side="left")
        ttk.Checkbutton(f, text="点歌", variable=self.var_music).pack(side="left", padx=8)
        ttk.Checkbutton(f, text="抖音自动刷", variable=self.var_douyin).pack(side="left")

        bar = ttk.Frame(wrap)
        bar.pack(fill="x", pady=18)
        ttk.Button(bar, text="保存并写入配置", style="Accent.TButton",
                   command=self.save_and_apply).pack(side="left")
        ttk.Button(bar, text="导入配置", command=self.import_profile).pack(side="left", padx=8)
        ttk.Button(bar, text="导出配置", command=self.export_profile).pack(side="left")

        self.lbl_cfg = ttk.Label(wrap, text="", style="Dim.TLabel")
        self.lbl_cfg.pack(fill="x", pady=6)

    def _build_run(self) -> None:
        wrap = ttk.Frame(self.tab_run)
        wrap.pack(fill="both", expand=True, padx=16, pady=14)

        self.big = ttk.Label(wrap, text="● 未运行", style="Title.TLabel")
        self.big.pack(anchor="w")

        bar = ttk.Frame(wrap)
        bar.pack(fill="x", pady=14)
        ttk.Button(bar, text="▶ 一键启动", style="Accent.TButton", command=self.start_all).pack(side="left")
        ttk.Button(bar, text="■ 停止", command=self.stop_all).pack(side="left", padx=8)
        ttk.Button(bar, text="↻ 刷新状态", command=self.refresh_status).pack(side="left")
        ttk.Button(bar, text="打开 AstrBot 管理页", command=lambda: self._open("http://127.0.0.1:6185")).pack(side="left", padx=8)
        ttk.Button(bar, text="打开 SnowLuma", command=lambda: self._open("http://127.0.0.1:5099")).pack(side="left")

        self.svc = ttk.Treeview(wrap, columns=("svc", "state", "note"), show="headings", height=8)
        for c, t, w in (("svc", "服务", 200), ("state", "状态", 100), ("note", "说明", 560)):
            self.svc.heading(c, text=t)
            self.svc.column(c, width=w, anchor="w")
        self.svc.pack(fill="both", expand=True)

        ttk.Label(wrap, text="首次使用：先到 ② 填好 QQ 和 Key，再点「一键启动」；扫码登录会在 SnowLuma 页面里进行。",
                  style="Dim.TLabel").pack(anchor="w", pady=8)

    def _build_log(self) -> None:
        wrap = ttk.Frame(self.tab_log)
        wrap.pack(fill="both", expand=True, padx=12, pady=10)
        bar = ttk.Frame(wrap)
        bar.pack(fill="x")
        ttk.Button(bar, text="刷新", command=self.load_logs).pack(side="left")
        ttk.Button(bar, text="打开日志目录", command=lambda: self._open(LOGDIR)).pack(side="left", padx=8)
        self.txt = tk.Text(wrap, bg="#0b1219", fg=C["ink"], insertbackground=C["ink"],
                           font=("Consolas", 9), wrap="none")
        self.txt.pack(fill="both", expand=True, pady=8)

    # ---- 动作
    def refresh_checks(self) -> None:
        for i in self.tree.get_children():
            self.tree.delete(i)
        res = run_checks(self.profile)
        bad = sum(1 for _, s, _ in res if s == "bad")
        warn = sum(1 for _, s, _ in res if s == "warn")
        for name, state, detail in res:
            label = {"ok": "✅ 正常", "warn": "⚠️ 注意", "bad": "❌ 必须修"}[state]
            self.tree.insert("", "end", values=(name, label, detail), tags=(state,))
        self.lbl_check_sum.config(text=f"共 {len(res)} 项：{len(res)-bad-warn} 正常 / {warn} 注意 / {bad} 必须修")

    def save_and_apply(self) -> None:
        self.profile.update({
            "qq": self.var_qq.get().strip(),
            "auth_mode": self.var_auth.get(),
            "qq_password": self.var_pwd.get(),
            "deepseek_key": self.var_key.get().strip(),
            "netease_cookie": self.var_cookie.get().strip(),
            "onebot_port": int(self.var_port.get() or 3000),
            "enable_sing": self.var_sing.get(),
            "enable_music": self.var_music.get(),
            "enable_douyin": self.var_douyin.get(),
        })
        save_profile(self.profile)
        script = os.path.join(HERE, "scripts", "apply-config.ps1")
        if not os.path.exists(script):
            self.lbl_cfg.config(text="已保存到 profile.json（apply-config.ps1 不存在，跳过写入服务配置）")
            return
        code, out = run_ps(script, timeout=180)
        self.lbl_cfg.config(text=("配置已写入 ✅ " if code == 0 else "写入失败 ❌ ") + out.strip()[-400:])
        self.refresh_checks()

    def import_profile(self) -> None:
        p = filedialog.askopenfilename(filetypes=[("JSON", "*.json")])
        if not p:
            return
        try:
            with open(p, encoding="utf-8") as f:
                self.profile.update(json.load(f))
            save_profile(self.profile)
            self.var_qq.set(str(self.profile.get("qq", "")))
            self.var_key.set(str(self.profile.get("deepseek_key", "")))
            self.lbl_cfg.config(text=f"已导入 {os.path.basename(p)}")
        except Exception as e:  # noqa: BLE001
            messagebox.showerror("导入失败", str(e))

    def export_profile(self) -> None:
        p = filedialog.asksaveasfilename(defaultextension=".json", filetypes=[("JSON", "*.json")])
        if not p:
            return
        data = dict(self.profile)
        data["qq_password"] = ""
        data["deepseek_key"] = ""
        with open(p, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        self.lbl_cfg.config(text=f"已导出（已抹掉密码和 Key）：{p}")

    def _open(self, target: str) -> None:
        try:
            os.startfile(target)  # type: ignore[attr-defined]
        except Exception as e:  # noqa: BLE001
            messagebox.showerror("打不开", str(e))

    def start_all(self) -> None:
        script = os.path.join(HERE, "scripts", "start-all.ps1")
        if not os.path.exists(script):
            messagebox.showerror("缺少脚本", f"找不到 {script}")
            return
        self.big.config(text="● 正在启动…", foreground=C["warn"])
        threading.Thread(target=self._bg, args=(script, "启动完成 ✅", "启动失败 ❌"), daemon=True).start()

    def stop_all(self) -> None:
        script = os.path.join(HERE, "scripts", "stop-all.ps1")
        if not os.path.exists(script):
            messagebox.showerror("缺少脚本", f"找不到 {script}")
            return
        threading.Thread(target=self._bg, args=(script, "已停止", "停止时出错"), daemon=True).start()

    def _bg(self, script: str, ok_text: str, bad_text: str) -> None:
        code, out = run_ps(script, timeout=900, capture=True)
        with open(os.path.join(LOGDIR, "control.log"), "a", encoding="utf-8") as f:
            f.write(f"\n=== {time.strftime('%F %T')} {os.path.basename(script)} exit={code}\n{out}\n")
        self.after(0, lambda: self.big.config(
            text=f"● {ok_text if code == 0 else bad_text}", foreground=C["ok"] if code == 0 else C["bad"]))
        self.after(0, self.refresh_status)

    def refresh_status(self) -> None:
        self.lbl_clock.config(text=time.strftime("本机时间 %F %H:%M:%S"))
        services = [("OneBot (SnowLuma)", int(self.profile.get("onebot_port", 3000))),
                    ("AstrBot WebUI", 6185), ("SnowLuma WebUI", 5099),
                    ("语音合成 TTS", 9880), ("语音识别 STT", 8000), ("向量检索 Embedding", 8100)]
        for i in self.svc.get_children():
            self.svc.delete(i)
        alive = 0
        for name, port in services:
            up = port_open(port)
            alive += up
            self.svc.insert("", "end", values=(name, "✅ 运行中" if up else "— 未启动", f"127.0.0.1:{port}"))
        self.big.config(text=f"● 运行中（{alive}/{len(services)} 个服务在线）" if alive else "● 未运行",
                        foreground=C["ok"] if alive else C["dim"])
        self.after(5000, self.refresh_status)

    def load_logs(self) -> None:
        self.txt.delete("1.0", "end")
        files = [p for p in (os.path.join(LOGDIR, "control.log"),
                             os.path.join(ASTRBOT_HOME, "data", "logs", "astrbot.log")) if os.path.exists(p)]
        if not files:
            self.txt.insert("end", "还没有日志。先点「一键启动」。\n")
            return
        for p in files:
            self.txt.insert("end", f"\n===== {p} =====\n")
            try:
                with open(p, encoding="utf-8", errors="replace") as f:
                    lines = f.readlines()[-200:]
                self.txt.insert("end", "".join(lines))
            except Exception as e:  # noqa: BLE001
                self.txt.insert("end", f"读取失败: {e}\n")


def selftest() -> int:
    profile = load_profile()
    print(f"== {APP_NAME} 自检 ==")
    bad = 0
    for name, state, detail in run_checks(profile):
        mark = {"ok": "[OK]  ", "warn": "[WARN]", "bad": "[BAD] "}[state]
        if state == "bad":
            bad += 1
        print(f"{mark} {name}: {detail}")
    print(f"\n必须修的问题: {bad} 项")
    return 0 if bad == 0 else 1


def main() -> None:
    if "--selftest" in sys.argv:
        raise SystemExit(selftest())
    tab = 0
    for i, a in enumerate(sys.argv):
        if a == "--tab" and i + 1 < len(sys.argv):
            try:
                tab = int(sys.argv[i + 1])
            except ValueError:
                tab = 0
    app = App()
    try:
        app.nb.select(tab)
    except Exception:
        pass
    app.mainloop()


if __name__ == "__main__":
    main()
