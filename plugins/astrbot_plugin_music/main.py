"""点歌：私聊或群里 @她 说「点歌 晴天」，回一段试听片段。

链路：网易云搜索 → 外链接口取 mp3 → ffmpeg 切 40 秒 → 作为语音发回去。
限制：每人每天 8 首、全局 40 首；拿不到的（会员曲/版权下架）直说，不放半首歌。

注意：只发**片段**不发整曲，用于聊天里"放一段听听"。
"""
import asyncio
import hashlib
import json
import os
import re
import subprocess
import time
import urllib.parse
import urllib.request

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register
from astrbot.core.message.components import Plain, Record

TMP = r"D:/AstrBot/data\temp\music"
STATE = r"D:/AstrBot/music-state.json"
FFMPEG = r"C:\Users\ruanr\.dsh\bili-whale\bin\ffmpeg.exe"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"
COOKIE_FILE = r"D:/AstrBot/netease.cookie"
PER_USER_DAILY = 8
GLOBAL_DAILY = 40
CLIP_SECONDS = 15
FULL_HINT = "完整版我这里不放（版权），想听整首去音乐软件搜一下歌名 + 歌手就行。"

# 触发词覆盖口语：「帮我播放X」「给我来一首X」「放歌X」…（裸「放」不行，「放假」会误触发）
# 2026-10-22：去掉「唱一首 / 唱首」—— 那是 sing 插件的地盘；并且把「来/快/现在/能不能/你」这类
# 前置垫词改成可重复匹配（原来只认 帮我/给我/麻烦/替我，好友说「来给我放首歌」会漏掉）。
_NOISE = (r"(?:来|快|现在就|现在|那就|那你|你|麻烦|请|能不能|能|可不可以|可以|"
          r"帮我|给我|帮忙|替我|再|还|先|马上)\s*")
TRIGGER = re.compile(
    r"^\s*(?:/)?\s*(?:" + _NOISE + r")*"
    r"(?:点歌|点一首|点首|点个歌|播放音乐|播放|放首歌|放一首|放个歌|放歌|放首|"
    r"来一首|来首歌|来首|播一首|播个|整一首|一首|首歌)"
    r"\s*[:：]?\s*(.*)$",
    re.S,
)


def _cookie() -> str:
    """读主人的会员 cookie（MUSIC_U），并补齐 320k 直链需要的设备字段。

    2026-10-22 实测：只带 MUSIC_U/__csrf 时，官方播放接口虽然返回了 URL，但 CDN 一律 403；
    再补上 _ntes_nuid / NMTID / os=pc / appver / channel 之后才 200（fee=1 的原唱也能下）。
    """
    try:
        d = {}
        with open(COOKIE_FILE, encoding="utf-8") as f:
            for line in f:
                p = line.strip().split(None, 1)
                if len(p) == 2:
                    d[p[0]] = p[1]
        if not d.get("MUSIC_U"):
            return ""
        seed = d["MUSIC_U"].encode()
        d.setdefault("_ntes_nuid", hashlib.md5(b"nuid:" + seed).hexdigest())
        d.setdefault("NMTID", "02" + hashlib.md5(b"nmt:" + seed).hexdigest()[:20].upper())
        d.setdefault("os", "pc")
        d.setdefault("appver", "9.2.20")
        d.setdefault("channel", "netease")
        return "; ".join(f"{k}={v}" for k, v in d.items())
    except Exception:
        return ""


def _get(url: str, timeout=20, retries=3):
    """带重试的 GET。网易云偶尔 TLS 握手失败/限流，重试一般就过了。"""
    h = {"user-agent": UA, "referer": "https://music.163.com/"}
    ck = _cookie()
    if ck:
        h["cookie"] = ck
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=h)
            return urllib.request.urlopen(req, timeout=timeout)
        except Exception as e:
            last = e
            if i + 1 < retries:
                time.sleep(0.8 * (i + 1))
    raise last


def song_url(sid: int, level: str = "exhigh") -> str:
    """官方播放接口取直链（320k mp3）。会员曲没 cookie 会返回空 url。"""
    api = (f"https://music.163.com/api/song/enhance/player/url/v1"
           f"?ids=[{sid}]&level={level}&encodeType=mp3")
    try:
        with _get(api, timeout=20) as r:
            j = json.loads(r.read().decode())
        item = (j.get("data") or [{}])[0]
        url = item.get("url") or ""
        if not url:
            logger.warning(f"[music] 无直链 sid={sid} code={item.get('code')} fee={item.get('fee')}")
        return url
    except Exception as e:
        logger.warning(f"[music] song_url 失败 sid={sid}: {type(e).__name__}: {str(e)[:120]}")
        return ""


def search(q: str) -> list:
    url = f"https://music.163.com/api/search/get/web?s={urllib.parse.quote(q)}&type=1&limit=5&offset=0"
    with _get(url) as r:
        data = json.loads(r.read().decode())
    return data.get("result", {}).get("songs") or []


def pick(songs: list, q: str) -> dict | None:
    """简单排序：歌名完全命中的优先，其次歌手名出现在查询里的。"""
    if not songs:
        return None
    ql = q.lower()

    BAD = ("翻唱", "cover", "伴奏", "纯音乐", "钢琴版", "深情版", "dj", "铃声", "片段", "live", "remix", "抖音", "治愈版", "合唱版", "女生版", "女声版", "男声版", "男版", "0.8x", "降调", "翻自", "填词")

    def score(s):
        name = (s.get("name") or "").lower()
        base = re.sub(r"[（(].*?[)）]", "", name).strip()   # 去掉「(深情版)」这类后缀
        artists = " ".join(a.get("name", "") for a in (s.get("artists") or [])).lower()
        n = 0
        if name == ql or base == ql:
            n += 100
        if ql in name or (base and base in ql):
            n += 40
        if artists and any(tok and tok in ql for tok in artists.split()):
            n += 30
        if ql in artists:
            n += 20
        if any(b in name for b in BAD):
            n -= 60        # 翻唱/伴奏/DJ 版降权
        return n

    return max(songs, key=score)


def rank(songs: list, q: str, n: int = 5) -> list:
    """按匹配度排序取前 n 个，供「第一个拿不到就试下一个」用。"""
    if not songs:
        return []
    ql = q.lower()
    BAD = ("翻唱", "cover", "伴奏", "纯音乐", "钢琴版", "深情版", "治愈版", "合唱版",
           "女生版", "女声版", "男声版", "男版", "dj", "铃声", "片段", "live", "remix",
           "抖音", "0.8x", "降调", "翻自", "填词")

    def score(s):
        name = (s.get("name") or "").lower()
        base = re.sub(r"[（(].*?[)）]", "", name).strip()
        artists = " ".join(a.get("name", "") for a in (s.get("artists") or [])).lower()
        v = 0
        if name == ql or base == ql:
            v += 100
        if ql in name or (base and base in ql):
            v += 40
        if artists and any(tok and tok in ql for tok in artists.split()):
            v += 30
        if ql in artists:
            v += 20
        if any(b in name for b in BAD):
            v -= 60
        return v

    return sorted(songs, key=score, reverse=True)[:n]


def _loudness_curve(wav_path: str) -> list:
    """每秒一个 RMS 值，用来找副歌（通常最响、最密的那段）。"""
    import wave, array, math
    with wave.open(wav_path, "rb") as w:
        rate = w.getframerate()
        n = w.getnframes()
        raw = w.readframes(n)
    samples = array.array("h")
    samples.frombytes(raw)
    step = rate  # 每秒
    curve = []
    for i in range(0, len(samples), step):
        chunk = samples[i:i + step]
        if not chunk:
            break
        s = 0
        for v in chunk:
            s += v * v
        curve.append(math.sqrt(s / len(chunk)))
    return curve


def _chorus_start(mp3_path: str, clip: int) -> float:
    """找 15 秒窗口里平均响度最高的位置；跳过前 15 秒（前奏/人声未进）。"""
    wav = mp3_path + ".wav"
    try:
        subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", mp3_path, "-ac", "1", "-ar", "16000", wav],
                       timeout=120, check=True)
        curve = _loudness_curve(wav)
        if len(curve) < clip + 15:
            return 0.0
        best_i, best_v = 15, -1.0
        for i in range(15, len(curve) - clip):
            v = sum(curve[i:i + clip]) / clip
            if v > best_v:
                best_v, best_i = v, i
        return float(best_i)
    except Exception:
        return 0.0
    finally:
        try:
            os.remove(wav)
        except Exception:
            pass


def fetch_clip(song: dict) -> str:
    sid = song["id"]
    os.makedirs(TMP, exist_ok=True)
    raw = os.path.join(TMP, f"{sid}.mp3")
    out = os.path.join(TMP, f"{sid}-clip.wav")

    data = b""
    h0 = {"user-agent": UA, "referer": "https://music.163.com/"}
    ck = _cookie()
    if ck:
        h0["cookie"] = ck
    # 直链有时效，失败就重新取一次（3 轮）
    for attempt in range(3):
        direct = song_url(sid)
        if not direct:
            time.sleep(0.8)
            continue
        try:
            with urllib.request.urlopen(urllib.request.Request(direct, headers=h0), timeout=60) as r:
                data = r.read()
        except Exception as e:
            logger.warning(f"[music] 直链下载失败 sid={sid} 第{attempt + 1}次: {type(e).__name__}: {str(e)[:100]}")
            data = b""
        if len(data) >= 200_000:
            break
        time.sleep(0.8)
    if len(data) < 200_000:  # 直链失败就退回外链接口（128k，够用）
        try:
            with _get(f"https://music.163.com/song/media/outer/url?id={sid}.mp3", timeout=60) as r:
                ctype = r.headers.get("content-type", "")
                data = r.read()
            if "audio" not in ctype:
                data = b""
        except Exception as e:
            logger.warning(f"[music] 外链也失败 sid={sid}: {type(e).__name__}: {str(e)[:100]}")
            data = b""
    if len(data) < 200_000:
        raise RuntimeError("这首拿不到（可能是会员曲或已下架）")
    with open(raw, "wb") as f:
        f.write(data)

    # 会员曲没买/没版权时常只给 30 秒试听：整首太短就别放，交给上层换下一个候选
    full = _duration(raw)
    if full < 25:
        logger.warning(f"[music] 只有 {full:.1f}s（试听片段）sid={sid}")
        raise RuntimeError(f"只有 {full:.0f} 秒试听")

    start = _chorus_start(raw, CLIP_SECONDS)   # 按响度找副歌；输出 16k 单声道 wav（QQ 对 44.1k 立体声 mp3 会说「无法播放」）
    subprocess.run(
        [FFMPEG, "-y", "-loglevel", "error", "-ss", f"{start:.1f}", "-t", str(CLIP_SECONDS),
         "-i", raw, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out],
        timeout=120, check=True,
    )
    try:
        os.remove(raw)
    except Exception:
        pass
    # 切出来太短（副歌点在文件尾巴外）也算失败，换下一个
    got = _duration(out)
    if got < 3:
        raise RuntimeError(f"切出来只有 {got:.1f}s")
    return out


def _duration(path: str) -> float:
    try:
        r = subprocess.run(
            [FFMPEG.replace("ffmpeg.exe", "ffprobe.exe"), "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, timeout=30,
        )
        return float((r.stdout or b"0").decode().strip() or 0)
    except Exception:
        return 0.0


def _quota_ok(uid: str) -> tuple[bool, str]:
    try:
        st = json.load(open(STATE, encoding="utf-8"))
    except Exception:
        st = {}
    today = time.strftime("%Y-%m-%d")
    rec = st.get(uid) or {"date": today, "n": 0}
    if rec.get("date") != today:
        rec = {"date": today, "n": 0}
    total = sum(v.get("n", 0) for v in st.values() if v.get("date") == today)
    if rec["n"] >= PER_USER_DAILY:
        return False, f"你今天点歌 {PER_USER_DAILY} 首了，明天再点"
    if total >= GLOBAL_DAILY:
        return False, "今天全网点歌额度用完了"
    rec["n"] += 1
    st[uid] = rec
    st = {k: v for k, v in st.items() if v.get("date") == today}
    try:
        json.dump(st, open(STATE, "w", encoding="utf-8"), ensure_ascii=False)
    except Exception:
        pass
    return True, ""


@register("music", "local", "点歌", "1.1.0")
class Music(Star):
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)
        self._busy = asyncio.Lock()

    @filter.event_message_type(filter.EventMessageType.ALL)
    async def on_message(self, event: AstrMessageEvent):
        m = TRIGGER.match((event.message_str or "").strip())
        if not m:
            return
        q = m.group(1).strip().strip("：: ")
        uid = str(event.get_sender_id())

        # 明确要完整版/长一点的 → 不找歌，直接告诉他去哪儿听
        if re.search(r"完整|整首|全曲|整曲|全长|长一点|再长|多放|长点", q):
            yield event.plain_result(FULL_HINT)
            return
        if not q:
            yield event.plain_result("想听哪首？说「点歌 歌名」就行。")
            return

        ok, why = _quota_ok(uid)
        if not ok:
            yield event.plain_result(why + "。")
            return
        if self._busy.locked():
            yield event.plain_result("上一首还在放，等一下。")
            return

        async with self._busy:
            try:
                songs = await asyncio.to_thread(search, q)
                if not songs:
                    yield event.plain_result(f"没搜到「{q}」，换个说法试试。")
                    return
                cands = rank(songs, q, 5)
                song = None
                path = None
                for c in cands:
                    try:
                        path = await asyncio.to_thread(fetch_clip, c)
                        song = c
                        break
                    except Exception:
                        continue
                if not song or not path:
                    yield event.plain_result(f"「{q}」的候选都拿不到（多半是会员曲），换一首试试。")
                    return
                name = song.get("name") or q
                artists = "/".join(a.get("name", "") for a in (song.get("artists") or []))
                note = "" if song is cands[0] else "（原版是会员曲，这段是别的版本）"
                yield event.chain_result([
                    Plain(text=f"《{name}》— {artists}，高潮那 {CLIP_SECONDS} 秒：{note}\n{FULL_HINT}"),
                    Record.fromFileSystem(path),
                ])
                logger.info(f"[music] ok uid={uid} {name}/{artists}")
            except Exception as e:
                logger.warning(f"[music] fail: {e}")
                yield event.plain_result(f"没放成：{str(e)[:80]}")
