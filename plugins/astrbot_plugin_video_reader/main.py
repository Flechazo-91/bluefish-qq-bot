"""私聊视频解读插件。

好友发来视频 → 抽九宫格关键帧 → qwen3-vl 描述画面（含画面里的字幕）
            → 音轨交本地 whisper 转写
            → 两段结果注入本轮 LLM 请求，让模型「像看过一样」回复。

边界（刻意收窄）：
  · 只处理私聊（群里不触发，避免刷屏/被滥用）
  · 视频 ≤ 180 秒，超时直接放弃（本地 whisper 是 CPU，长视频会拖死这一轮）
  · 任何一步失败都不抛异常 —— 插件绝不能因为一次解读失败把回复搞没
"""
import asyncio
import os
import sys
import tempfile
import urllib.request

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.message_components import Video
from astrbot.api.provider import ProviderRequest
from astrbot.api.star import Context, Star, register
from astrbot.core.agent.message import TextPart

sys.path.insert(0, r"D:/AstrBot")
import video_reader  # noqa: E402

MAX_SECONDS = 180
ANALYZE_TIMEOUT = 150
_seen: set[str] = set()


@register("video_reader", "local", "私聊视频解读", "1.0.0")
class VideoReaderPlugin(Star):
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)

    @filter.on_llm_request(priority=1)
    async def inject_video_context(self, event: AstrMessageEvent, req: ProviderRequest):
        try:
            if not event.is_private_chat():
                return
            vids = [c for c in event.get_messages() if isinstance(c, Video)]
            if not vids:
                return

            vid = vids[0]
            key = f"{event.get_sender_id()}:{getattr(vid, 'file', '')}:{getattr(vid, 'url', '')}"
            if key in _seen:
                return
            _seen.add(key)
            if len(_seen) > 200:
                _seen.clear()

            path = await asyncio.to_thread(self._resolve, vid)
            if not path:
                logger.warning("[video_reader] 拿不到视频文件，跳过")
                return

            info = await asyncio.wait_for(
                asyncio.to_thread(video_reader.analyze, path, True), timeout=ANALYZE_TIMEOUT
            )
            if not info.get("ok"):
                logger.info(f"[video_reader] 未解读成功：{info.get('summary', '')[:80]}")
                return

            block = (
                f"[视频] 对方刚发来一段 {info['duration']:.0f} 秒的视频，**你已经看过**：\n"
                f"{info['summary']}\n"
                "按要求直接回应视频内容（挑画面里具体的细节说），"
                "不要再说「看不了视频」「没接上」「你直接讲讲」这类话 —— 这次你是真的看到了。"
            )
            # 双写：system 里一句 + user 侧强提示（后者权重更高，能压住前几轮「看不了」的惯性）
            req.system_prompt = (req.system_prompt or "") + "\n[你已经看过对方刚发的视频，回答要基于视频内容]"
            req.extra_user_content_parts.append(TextPart(text=block))
            logger.info(f"[video_reader] 已注入视频解读（{info['duration']:.0f}s, "
                        f"画面 {len(info.get('visual') or '')} 字, 语音 {len(info.get('audio') or '')} 字）")
        except asyncio.TimeoutError:
            logger.warning("[video_reader] 解读超时，本轮按普通消息处理")
        except Exception as e:  # 绝不抛给主流程
            logger.warning(f"[video_reader] 异常已吞掉：{e}")

    @staticmethod
    def _resolve(vid: Video) -> str | None:
        """把 Video 组件落成本地文件。优先本地路径，其次下载 url。"""
        for cand in (getattr(vid, "path", None), getattr(vid, "file", None)):
            if cand and isinstance(cand, str) and os.path.exists(cand):
                return cand
        url = getattr(vid, "url", None)
        if not url:
            return None
        out = os.path.join(tempfile.gettempdir(), f"vid_{abs(hash(url)) % 10**10}.mp4")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=60) as r, open(out, "wb") as f:
                f.write(r.read())
            return out if os.path.getsize(out) > 1024 else None
        except Exception as e:
            logger.warning(f"[video_reader] 下载失败：{e}")
            return None
