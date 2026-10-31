"""睡眠模式：到点了（默认 00:00–08:00）有人找她，先回一句「睡觉中」并记下来，早上再回。

为什么需要：主人给机器设了作息，夜里要么待机要么关机。待机时消息还能收到，
但没人处理；关机时更收不到。这个插件负责“夜里有人找 → 先安抚一句 + 记账”，
等早上机器醒了由 morning.mjs 统一补一句「我醒了，你昨晚发的我看到了」。

配置：D:\\AstrBot\\sleep-config.json
  {
    "enabled": true,
    "start": "00:00",
    "end": "08:00",
    "message": "大肥鱼睡觉中，等他起了就回复你。",
    "cooldownMin": 30,          // 同一个人 30 分钟内只回一次“睡觉中”，免得刷屏
    "queueFile": "D:\\\\AstrBot\\\\sleep-pending.jsonl"
  }
"""
import json
import os
import time
from datetime import datetime

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register

CFG = r"D:/AstrBot/sleep-config.json"
DEFAULT_CFG = {
    "enabled": True,
    "start": "00:00",
    "end": "08:00",
    "message": "大肥鱼睡觉中，等他起了就回复你。",
    "cooldownMin": 30,
    "queueFile": r"D:/AstrBot/sleep-pending.jsonl",
}


def _cfg() -> dict:
    c = dict(DEFAULT_CFG)
    try:
        with open(CFG, encoding="utf-8") as f:
            c.update(json.load(f))
    except Exception:
        pass
    return c


def _mins(hhmm: str) -> int:
    try:
        h, m = str(hhmm).split(":")
        return int(h) * 60 + int(m)
    except Exception:
        return -1


def in_window(cfg: dict, now: datetime | None = None) -> bool:
    now = now or datetime.now()
    s, e = _mins(cfg.get("start", "00:00")), _mins(cfg.get("end", "08:00"))
    cur = now.hour * 60 + now.minute
    if s < 0 or e < 0 or s == e:
        return False
    if s < e:
        return s <= cur < e
    return cur >= s or cur < e          # 跨零点


@register("sleep_mode", "local", "睡眠模式", "1.0.0")
class SleepMode(Star):
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)
        self._last: dict[str, float] = {}

    @filter.event_message_type(filter.EventMessageType.ALL, priority=100)
    async def on_message(self, event: AstrMessageEvent):
        cfg = _cfg()
        if not cfg.get("enabled", True):
            return
        if not in_window(cfg):
            return
        uid = str(event.get_sender_id())
        text = (event.message_str or "").strip()
        if not text:
            return

        # 记账：早上 morning.mjs 会读这个文件补回话
        try:
            with open(cfg.get("queueFile", DEFAULT_CFG["queueFile"]), "a", encoding="utf-8") as f:
                f.write(json.dumps({
                    "at": datetime.now().isoformat(timespec="seconds"),
                    "uid": uid,
                    "text": text[:200],
                }, ensure_ascii=False) + "\n")
        except Exception as e:
            logger.warning(f"[sleep_mode] 记账失败：{e}")

        now = time.time()
        cooldown = float(cfg.get("cooldownMin", 30)) * 60
        if now - self._last.get(uid, 0) >= cooldown:
            self._last[uid] = now
            logger.info(f"[sleep_mode] 夜间回复 {uid}: {text[:20]}")
            yield event.plain_result(cfg.get("message", DEFAULT_CFG["message"]))
        event.stop_event()
