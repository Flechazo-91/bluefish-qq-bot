"""文生图：用户/好友说「画一张……」，直接生成图片发回去。

主用 **SiliconFlow 的 FLUX.1-schnell**（一分钱一张、中文提示也能听、3–8 秒出图）；
key 缺失或调用失败时自动回落到 DashScope 的 wanx-v1。

配置：D:\\AstrBot\\img_config.json（选 provider、模型、尺寸）
密钥：D:\\AstrBot\\siliconflow.key（一行纯文本，不要把 key 写进聊天）

成本控制：
  1. 同提示词 7 天缓存（零成本复用）
  2. 每人每天 6 张、全局每天 30 张
"""
import asyncio
import hashlib
import json
import os
import re
import time
import urllib.request

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register
from astrbot.core.message.components import Image, Plain

IMG_CONF = r"D:/AstrBot/img_config.json"
SF_KEY_FILE = r"D:/AstrBot/siliconflow.key"
VISION_CONF = r"D:/AstrBot/vision_config.json"
STATE = r"D:/AstrBot/gen-image-state.json"
LEDGER = r"D:/AstrBot/gen-image-spend.jsonl"
OUT_DIR = r"D:/AstrBot/data\temp\gen"
CACHE_DIR = os.path.join(OUT_DIR, "_cache")
DASHSCOPE_API = "https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis"
DASHSCOPE_TASK = "https://dashscope.aliyuncs.com/api/v1/tasks/{}"
PER_USER_DAILY = 6
GLOBAL_DAILY = 30
CACHE_DAYS = 7

# 覆盖口语前缀：「帮我生成…」「给我画个…」「能不能画张…」
# 2026-10-22：补上「文生图 / 生图 / 画图」这几种说法，垫词（来/快/现在/你能不能…）改成可重复匹配。
_NOISE = (r"(?:来|快|现在就|现在|那就|那你|你|麻烦|请|能不能|能|可不可以|可以|"
          r"帮我|给我|帮忙|替我|再|先|马上)\s*")
TRIGGER = re.compile(
    r"^\s*(?:/)?\s*(?:" + _NOISE + r")*"
    r"(?:文生图|生图|画一张图|画图|画一张|画个|画一幅|画张|画|生成一张|生成图片|生成|来一张|做一张|出图)"
    r"\s*[:：]?\s*(.+)$",
    re.S,
)


# ── 配置与密钥
def _conf() -> dict:
    try:
        return json.load(open(IMG_CONF, encoding="utf-8"))
    except Exception:
        return {}


def _sf_key() -> str:
    try:
        return open(SF_KEY_FILE, encoding="utf-8").read().strip()
    except Exception:
        return ""


def _dashscope_key() -> str:
    try:
        return json.load(open(VISION_CONF, encoding="utf-8")).get("api_key", "")
    except Exception:
        return ""


def _cache_path(prompt: str, tag: str) -> str:
    h = hashlib.sha1(f"{tag}|{prompt.strip().lower()}".encode()).hexdigest()[:16]
    return os.path.join(CACHE_DIR, f"{h}.jpg")


# ── SiliconFlow / FLUX.1-schnell
def _log_spend(provider: str, model: str, cached: bool = False) -> None:
    """每张图记一笔，供日报统计；缓存命中记 0 成本。"""
    try:
        unit = 0.0 if cached else float(_conf().get("cost", {}).get(provider, 0))
        rec = {"at": int(time.time()), "provider": provider, "model": model,
               "cost": round(unit, 4), "cached": cached}
        with open(LEDGER, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _gen_siliconflow(prompt: str, out: str) -> str:
    conf = _conf().get("siliconflow", {})
    key = _sf_key()
    if not key:
        raise RuntimeError("没有 siliconflow.key")
    body = {
        "model": conf.get("model", "black-forest-labs/FLUX.1-schnell"),
        "prompt": prompt,
        "image_size": conf.get("size", "768x768"),
        "batch_size": 1,
        "num_inference_steps": int(conf.get("steps", 4)),
    }
    req = urllib.request.Request(
        conf.get("base", "https://api.siliconflow.cn/v1/images/generations"),
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.loads(r.read().decode())
    url = ((data.get("images") or [{}])[0]).get("url")
    if not url:
        raise RuntimeError(f"siliconflow 返回异常：{str(data)[:120]}")
    with urllib.request.urlopen(url, timeout=90) as r, open(out, "wb") as f:
        f.write(r.read())
    _crop_watermark(out)
    return out


def _crop_watermark(path: str, px: int = 64) -> None:
    """SiliconFlow 各模型都会在右下角打「AI生成」，裁掉底部一条。"""
    try:
        from PIL import Image as PILImage
        with PILImage.open(path) as im:
            im.load()
            w, h = im.size
            if h <= px + 64:
                return
            cropped = im.crop((0, 0, w, h - px))
            if cropped.mode in ("RGBA", "LA", "P"):
                cropped = cropped.convert("RGB")   # PNG 带 alpha，直接存 JPEG 会报 cannot write mode RGBA
            tmp = path + ".tmp.jpg"
            cropped.save(tmp, quality=92)
        os.replace(tmp, path)   # 必须先存到临时文件再替换，直接存回去会得到 0 字节
    except Exception as e:
        logger.warning(f"[img_gen] 裁水印失败：{e}")


# ── DashScope wanx（兜底）
def _gen_wanx(prompt: str, out: str) -> str:
    conf = _conf().get("wanx", {})
    key = _dashscope_key()
    if not key:
        raise RuntimeError("没有 DashScope key")
    body = {
        "model": conf.get("model", "wanx-v1"),
        "input": {"prompt": prompt, "negative_prompt": "低质量, 模糊, 文字, 水印"},
        "parameters": {"size": conf.get("size", "768*1152"), "n": 1},
    }
    req = urllib.request.Request(
        DASHSCOPE_API,
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                 "X-DashScope-Async": "enable"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        tid = json.loads(r.read().decode()).get("output", {}).get("task_id")
    if not tid:
        raise RuntimeError("wanx 创建任务失败")

    deadline = time.time() + 200
    url = None
    while time.time() < deadline:
        time.sleep(4)
        q = urllib.request.Request(DASHSCOPE_TASK.format(tid), headers={"Authorization": f"Bearer {key}"})
        out_json = json.loads(urllib.request.urlopen(q, timeout=20).read().decode()).get("output", {})
        st = out_json.get("task_status")
        if st == "SUCCEEDED":
            res = out_json.get("results") or []
            if res:
                url = res[0].get("url")
            break
        if st in ("FAILED", "UNKNOWN"):
            raise RuntimeError(f"wanx 失败：{out_json.get('message') or st}")
    if not url:
        raise RuntimeError("wanx 超时")
    with urllib.request.urlopen(url, timeout=60) as r, open(out, "wb") as f:
        f.write(r.read())
    return out


def generate(prompt: str) -> str:
    """按配置选 provider，失败自动回落。命中缓存零成本。"""
    os.makedirs(CACHE_DIR, exist_ok=True)
    conf = _conf()
    primary = str(conf.get("provider", "siliconflow")).lower()
    tag = f"{primary}|{json.dumps(conf.get(primary, {}), sort_keys=True, ensure_ascii=False)}|{prompt.strip().lower()}"
    cached = _cache_path(prompt, tag)
    if os.path.exists(cached) and (time.time() - os.path.getmtime(cached)) < CACHE_DAYS * 86400:
        logger.info("[img_gen] 命中缓存")
        _log_spend(primary, str(conf.get(primary, {}).get("model", "")), cached=True)
        return cached

    errors = []
    order = [primary, "wanx"] if primary != "wanx" else ["wanx"]
    for which in order:
        try:
            if which == "siliconflow":
                path = _gen_siliconflow(prompt, cached)
            elif which == "wanx":
                path = _gen_wanx(prompt, cached)
            else:
                continue
            logger.info(f"[img_gen] provider={which}")
            _log_spend(which, str(conf.get(which, {}).get("model", "")))
            return path
        except Exception as e:
            errors.append(f"{which}: {e}")
            logger.warning(f"[img_gen] {which} 失败：{e}")
    raise RuntimeError("；".join(errors)[:150])


# ── 配额
def _quota_ok(uid: str) -> tuple[bool, str]:
    try:
        st = json.load(open(STATE, encoding="utf-8"))
    except Exception:
        st = {}
    today = time.strftime("%Y-%m-%d")
    rec = st.get(uid) or {}
    if rec.get("date") != today:
        rec = {"date": today, "n": 0}
    total = sum(v.get("n", 0) for v in st.values() if v.get("date") == today)
    if rec["n"] >= PER_USER_DAILY:
        return False, f"你今天的 {PER_USER_DAILY} 张用完了"
    if total >= GLOBAL_DAILY:
        return False, "今天大家画的总额度用完了"
    rec["n"] += 1
    st[uid] = rec
    st = {k: v for k, v in st.items() if v.get("date") == today}
    try:
        json.dump(st, open(STATE, "w", encoding="utf-8"), ensure_ascii=False)
    except Exception:
        pass
    return True, ""


@register("img_gen", "local", "文生图", "1.3.0")
class ImageGen(Star):
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)
        self._busy = asyncio.Lock()

    @filter.event_message_type(filter.EventMessageType.ALL)
    async def on_message(self, event: AstrMessageEvent):
        m = TRIGGER.match((event.message_str or "").strip())
        if not m:
            return
        prompt = m.group(1).strip().strip("：: ")
        if len(prompt) < 2:
            return

        uid = str(event.get_sender_id())
        ok, why = _quota_ok(uid)
        if not ok:
            yield event.plain_result(f"画不了了：{why}。")
            return
        if self._busy.locked():
            yield event.plain_result("手上还有一张没画完，稍等我一下。")
            return

        async with self._busy:
            yield event.plain_result("画着呢，稍等几秒。")
            try:
                path = await asyncio.to_thread(generate, prompt)
                yield event.chain_result([Plain(text="好了，你看这张："), Image.fromFileSystem(path)])
                logger.info(f"[img_gen] ok uid={uid} prompt={prompt[:30]}")
            except Exception as e:
                logger.warning(f"[img_gen] fail: {e}")
                yield event.plain_result(f"没画出来：{str(e)[:80]}")
