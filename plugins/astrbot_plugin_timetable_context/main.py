"""把课表钉进每一轮对话的上下文（今天 / 明天 / 下一节 / 本周概览 / 三周明细）。

为什么需要：知识库里那张课表是**整周**的，检索时很容易把周二的课当成今天的
（2026-10-22 实测：周四问她下一节，她答"物理实验"——那是周五 5–6 节）。
所以在 LLM 请求前，直接按**真实日期**算好塞进去，不依赖检索。

2026-10-22 晚两轮修补：
  v1.1 原来只注入「今天」，别人问「明天上什么课」她只能答"明天课表没给到我" → 加明天/下一节。
  v1.2 主人要「本周 + 下两周」都能问到具体时间 → 平时仍注入紧凑块；
       一旦这轮消息像在问课表（课/课表/周X/几节/几点…），再加一份三周完整明细（含日期和起止时间）。
"""
import json
import os
import re
from datetime import datetime, timedelta

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.provider import ProviderRequest
from astrbot.api.star import Context, Star, register

TIMETABLE = r"D:/AstrBot/timetable.json"
WEEK_CN = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"]

# 哪些消息需要展开三周明细
_ASK = re.compile(r"课|课表|上课|几节|第几周|哪周|周[一二三四五六日天]|星期[一二三四五六日天]|"
                  r"安排|几点|什么时候上|下下周|下周|明天|后天|今天")


def _minutes(hhmm: str) -> int:
    try:
        h, m = str(hhmm).split(":")
        return int(h) * 60 + int(m)
    except Exception:
        return -1


def _fmt(c: dict) -> str:
    room = f" @ {c['room']}" if c.get("room") else ""
    return f"{c.get('start')}–{c.get('end')} {c.get('name')}{room}"


def _day_courses(cfg: dict, day: datetime):
    """返回 (当天课程列表, 周标签, 是否缺这一周的课表)。按 weeks[] 命中，没命中退回扁平 courses[]。"""
    iso = day.strftime("%Y-%m-%d")
    weekday = day.isoweekday()
    weeks = cfg.get("weeks") or []
    cur = next((w for w in weeks if w.get("from") and w.get("to") and w["from"] <= iso <= w["to"]), None)
    courses = (cur or {}).get("courses") or cfg.get("courses") or []
    listed = sorted([c for c in courses if int(c.get("weekday", 0)) == weekday],
                    key=lambda c: _minutes(c.get("start", "00:00")))
    return listed, (cur or {}).get("label", ""), bool(weeks) and cur is None


def _week_index(weeks, iso):
    return next((i for i, w in enumerate(weeks)
                 if w.get("from") and w.get("to") and w["from"] <= iso <= w["to"]), -1)


def compact_block(cfg: dict, now: datetime) -> str:
    now_min = now.hour * 60 + now.minute
    today = now
    tomorrow = now + timedelta(days=1)
    t_list, t_label, t_miss = _day_courses(cfg, today)
    m_list, m_label, m_miss = _day_courses(cfg, tomorrow)
    today_iso = today.strftime("%Y-%m-%d")
    tom_iso = tomorrow.strftime("%Y-%m-%d")

    weeks = cfg.get("weeks") or []
    cur_i = _week_index(weeks, today_iso)
    where = f"（{weeks[cur_i].get('label')} {WEEK_CN[today.isoweekday()]}）" if cur_i >= 0 else ""

    lines = [f"\n\n[课表] 按系统真实日期算好：现在 {now.strftime('%Y-%m-%d %H:%M')}{where}"]

    if t_miss:
        lines.append(f"今天（{today_iso} {WEEK_CN[today.isoweekday()]}）这一周课表还没录。")
    elif t_list:
        lines.append(f"今天 {today_iso}（{WEEK_CN[today.isoweekday()]}{'，' + t_label if t_label else ''}）共 {len(t_list)} 节：")
        lines += [f"- {_fmt(c)}" for c in t_list]
    else:
        lines.append(f"今天 {today_iso}（{WEEK_CN[today.isoweekday()]}）没有课。")

    if m_miss:
        lines.append(f"明天（{tom_iso} {WEEK_CN[tomorrow.isoweekday()]}）这一周课表还没录。")
    elif m_list:
        lines.append(f"明天 {tom_iso}（{WEEK_CN[tomorrow.isoweekday()]}{'，' + m_label if m_label else ''}）共 {len(m_list)} 节：")
        lines += [f"- {_fmt(c)}" for c in m_list]
    else:
        lines.append(f"明天 {tom_iso}（{WEEK_CN[tomorrow.isoweekday()]}）没有课。")

    # 本周概览
    pool = weeks[cur_i].get("courses") if cur_i >= 0 else (cfg.get("courses") or [])
    if pool:
        parts = []
        for d in range(1, 8):
            day_list = sorted([c for c in pool if int(c.get("weekday", 0)) == d],
                              key=lambda c: _minutes(c.get("start", "00:00")))
            parts.append(f"{WEEK_CN[d]} {len(day_list)} 节（{day_list[0].get('start')} 起）" if day_list
                         else f"{WEEK_CN[d]} 没课")
        lines.append("本周概览：" + " · ".join(parts))

    # 已录入的周次（问"下周/下下周"时有个时间锚点）
    if weeks:
        spans = " / ".join(f"{w.get('label')} {w.get('from')}~{w.get('to')}" for w in weeks)
        lines.append("已录入周次：" + spans)

    remain = [c for c in t_list if _minutes(c.get("end", "00:00")) >= now_min]
    if remain:
        nxt = remain[0]
        left = _minutes(nxt.get("start", "00:00")) - now_min
        lines.append(f"下一节：{_fmt(nxt)}，" + (f"还有 {left} 分钟。" if left > 0 else "现在正在上。"))
    elif m_list:
        lines.append(f"下一节：明天 {_fmt(m_list[0])}。")
    else:
        lines.append("接下来两天都没课。")

    lines.append("（以上是系统按真实日期算的，谁问都按这个答；不要回"
                 "“课表没给到我/我看不到”，也不要用知识库里其他天的课程。）")
    return "\n".join(lines)


def full_block(cfg: dict, now: datetime) -> str:
    """本周 + 下两周（以及所有已录入周次）的逐日明细，答"具体几点到几点"用。"""
    weeks = cfg.get("weeks") or []
    if not weeks:
        return ""
    today_iso = now.strftime("%Y-%m-%d")
    cur_i = _week_index(weeks, today_iso)
    lines = ["\n\n[课表·逐日明细] 下面是每一周的每一天、每节课的起止时间和教室："]
    for i, w in enumerate(weeks):
        tag = ""
        if i == cur_i:
            tag = "，本周"
        elif i == cur_i + 1:
            tag = "，下周"
        elif i == cur_i + 2:
            tag = "，下下周"
        lines.append(f"{w.get('label')}（{w.get('from')}~{w.get('to')}{tag}）")
        try:
            mon = datetime.strptime(w.get("from"), "%Y-%m-%d")
        except Exception:
            mon = None
        by_day = {}
        for c in (w.get("courses") or []):
            by_day.setdefault(int(c.get("weekday", 0)), []).append(c)
        for d in range(1, 8):
            day_list = sorted(by_day.get(d, []), key=lambda c: _minutes(c.get("start", "00:00")))
            date = (mon + timedelta(days=d - 1)).strftime("%m-%d") if mon else ""
            head = f"  {WEEK_CN[d]}" + (f"（{date}）" if date else "") + "："
            if day_list:
                lines.append(head + "；".join(_fmt(c) for c in day_list))
            else:
                lines.append(head + "没课")
    lines.append("（有人问某天/某周的课，就按这里的日期和起止时间回答；问到没录入的周次，才说“那一周还没录”。）")
    return "\n".join(lines)


def timetable_block(question: str = "") -> str:
    if not os.path.exists(TIMETABLE):
        return ""
    with open(TIMETABLE, encoding="utf-8") as f:
        cfg = json.load(f)
    now = datetime.now()
    text = compact_block(cfg, now)
    if question and _ASK.search(question):
        text += full_block(cfg, now)
    return text


@register("timetable_context", "local", "今日课表上下文", "1.2.0")
class TimetableContext(Star):
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)

    @filter.on_llm_request(priority=0)
    async def inject_timetable(self, event: AstrMessageEvent, req: ProviderRequest):
        try:
            q = ""
            try:
                q = event.message_str or ""
            except Exception:
                q = ""
            block = timetable_block(q)
            if block:
                req.system_prompt = (req.system_prompt or "") + block
        except Exception as e:  # 解析失败绝不影响正常回复
            logger.warning(f"[timetable_context] 注入失败：{e}")
