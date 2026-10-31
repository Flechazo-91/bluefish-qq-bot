"""唱歌：拿原曲 15 秒 → Demucs 分离人声 → Seed-VC 换成她的音色 → 和原伴奏混回去。

这才是「按原曲节奏唱」：旋律和伴奏都是原曲的，只有音色是她的。

链路（全部在本机跑，GPU 推理）：
    网易云搜歌 → 取 mp3 → 按响度找副歌 15 秒
    → demucs 分离 vocals / no_vocals
    → Seed-VC（F0 44k）把 vocals 换成她的音色（只按整八度搬调，保住和原伴奏的和声）
    → 与原伴奏混音（留头 + 响度归一到 -16 LUFS + 限幅，不再削波）
    → 16k 单声道 → 作为语音发出

依赖：D:\\seed-vc-env（torch 2.4 + demucs + Seed-VC）、权重在 D:\\seed-vc-main\\checkpoints
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

TMP = r"D:/AstrBot/data\temp\sing"
STATE = r"D:/AstrBot/sing-state.json"
PIPELINE = r"D:\seed-vc-main\pipeline.py"
SVC_PY = r"D:\seed-vc-env\Scripts\python.exe"
REF_AUDIO = r"D:\GPT-SoVITS\GPT-SoVITS-v2-240821\refs\loli_ref.wav"
FFMPEG = r"C:\Users\ruanr\.dsh\bili-whale\bin\ffmpeg.exe"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"
COOKIE_FILE = r"D:/AstrBot/netease.cookie"
CLIP_SECONDS = 15
PER_USER_DAILY = 5
GLOBAL_DAILY = 20
STEPS = 40  # 扩散步数：GPU 上 25→40 只多 1~2 秒，抖动更小

TRIGGER = re.compile(
    r"^\s*(?:/)?\s*(?:帮我|给我|帮忙|麻烦|替我)?\s*(?:唱一首|唱个|唱首|唱歌|唱一唱|唱)\s*[:：]?\s*(.*)$",
    re.S,
)

# 2026-10-22 晚：上面那条正则只认「句首 + 唱」。实测好友发「来给我唱首歌来。」「来唱周杰伦的青花瓷」
# 全都漏过去掉进大模型，她只好用嘴拒绝（「不唱，点多少次都一样」）。改成解析式：
# 先剥掉「来/给我/帮我/快/那你/能不能」这类口语垫词，再认「唱」，最后清量词和尾巴。
_FILLERS = ("来", "快去", "快", "现在就", "现在", "那就", "那你", "你", "麻烦", "请",
            "能不能", "能", "可不可以", "可以", "帮我", "给我", "帮忙", "替我", "再", "还",
            "先", "马上")
_QUANT = ("一首", "一个", "一段", "一下", "一唱", "首歌", "首", "个", "歌")
_TAIL = ("好不好", "好吗", "听听", "起来", "给我", "谢谢", "听",
         "吧", "呀", "啊", "呗", "嘛", "吗", "么", "呢", "来")
_LEAD_PUNCT = " \t，,。.！!？?~～、\u3000的《\"'“”【[（(：:"
_EDGE_PUNCT = " \t《》\"'“”【】[]（）()：:，,。.！!？?~～"
_TAIL_PUNCT = " 吧呀啊呗嘛吗么呢~～。，,、！!？?"


def _strip_start(s):
    changed = True
    while changed:
        changed = False
        s2 = s.lstrip(_LEAD_PUNCT)
        if s2 != s:
            s, changed = s2, True
        for f in _FILLERS:
            if s.startswith(f):
                s, changed = s[len(f):], True
                break
    return s


def _clean_tail(s):
    changed = True
    while changed:
        changed = False
        s2 = s.rstrip(_TAIL_PUNCT)
        if s2 != s:
            s, changed = s2, True
        for t in _TAIL:
            if s.endswith(t):
                s, changed = s[:-len(t)], True
                break
    return s


def parse_song(text):
    """返回歌名（空串＝随便唱一首）；不是点唱请求返回 None。"""
    s = (text or "").strip()
    if not s:
        return None
    # 群里 @她 时 AstrBot 有时会把 [At:xxx] / [引用消息...] 留在文本里，先剥掉
    s = re.sub(r"\[[^\]]{0,40}\]", " ", s).strip()
    if not s:
        return None
    s = _strip_start(s)
    if not s.startswith("唱"):
        # 2026-10-26：群里常见的「来给唱首爱错」「你给小王唱一首歌吧」，
        # 垫词剥完还剩下「给…」，句首不是「唱」但确实是点唱 → 在开头 12 个字里找「唱」
        m = re.search(r"唱(?:一首|一唱|个|首|歌)?\s*[:：]?\s*(.*)$", s[:14], re.S)
        if not m:
            return None
        s = "唱" + m.group(1)
    s = s[1:]
    for _ in range(3):
        s = s.lstrip(_LEAD_PUNCT)
        hit = False
        for q in _QUANT:
            if s.startswith(q):
                s, hit = s[len(q):], True
                break
        if not hit:
            break
    if s[:1] in ("得", "过", "了", "完", "着"):
        return None
    out = _clean_tail(s).strip(_EDGE_PUNCT)
    # 「唱一首歌吧，安慰一下他」→ 标题只取到第一个标点；太长就说明不是歌名
    out = re.split(r"[，。！？；,;!?]", out)[0].strip(_EDGE_PUNCT)
    if len(out) > 18:
        out = out[:18].strip(_EDGE_PUNCT)
    # 「唱首歌吧」「唱一个」这种没点名的，当成「随便来一首」
    if not out or out in ("歌", "曲", "首歌", "一段", "吧", "呀", "啊", "呗", "嘛", "吗", "呢"):
        return ""
    return out


def _cookie():
    """读主人的会员 cookie（MUSIC_U），补齐 320k 直链需要的设备字段。

    2026-10-22 实测：只带 MUSIC_U/__csrf 时接口给了 URL，但 CDN 一律 403；
    补 _ntes_nuid / NMTID / os=pc / appver / channel 之后才 200（fee=1 的原唱也能下）。
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


def _get(url, timeout=30, retries=3):
    """带重试的 GET（网易云偶尔 TLS 握手失败/限流）。"""
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


def song_url(sid, level="exhigh"):
    """官方播放接口取直链（320k mp3）；会员曲没 cookie 会返回空 url。"""
    api = (f"https://music.163.com/api/song/enhance/player/url/v1"
           f"?ids=[{sid}]&level={level}&encodeType=mp3")
    try:
        with _get(api, timeout=20) as r:
            j = json.loads(r.read().decode())
        item = (j.get("data") or [{}])[0]
        url = item.get("url") or ""
        if not url:
            logger.warning(f"[sing] 无直链 sid={sid} code={item.get('code')} fee={item.get('fee')}")
        return url
    except Exception as e:
        logger.warning(f"[sing] song_url 失败 sid={sid}: {type(e).__name__}: {str(e)[:120]}")
        return ""


def search(q):
    url = f"https://music.163.com/api/search/get/web?s={urllib.parse.quote(q)}&type=1&limit=30&offset=0"
    with _get(url) as r:
        return json.loads(r.read().decode()).get("result", {}).get("songs") or []


def split_query(q):
    """把「周杰伦的告白气球」拆成（歌手, 歌名）；拆不出来就（'', 原样）。"""
    t = (q or "").strip()
    m = re.match(r"^([^\s的]{2,12})的(.+)$", t)
    if m:
        return m.group(1).strip(), m.group(2).strip()
    m2 = re.match(r"^(.+?)\s+([^\s]{2,10})$", t)
    if m2:
        return m2.group(2).strip(), m2.group(1).strip()
    return "", t


def rank(songs, q, n=5):
    """给候选打分。

    2026-10-22 晚：主人说「来唱一首周杰伦的告白气球」，结果挑到《告白气球（原版）》/沈幼楚
    （朗读版），变声出来就是念白。根因是选歌：artist 只在 q 里出现才加分，不加分也不扣分，
    于是「歌名对但歌手不对」的朗读/翻唱版能赢过原唱。现在：
      · 先从 q 里拆出歌手/歌名，歌名比对用歌名部分；
      · q 里点名了歌手 → 歌手对不上直接重罚；
      · 朗读/念白/有声书/八音盒这类版本进黑名单。
    """
    if not songs:
        return []
    artist_guess, title = split_query(q)
    ql = title.lower()
    ag = artist_guess.lower()
    BAD = ("翻唱", "cover", "伴奏", "纯音乐", "钢琴", "吉他", "古筝", "尤克里里", "八音盒", "音乐盒",
           "深情版", "治愈版", "合唱版", "女生版", "女声版", "男声版", "男版", "dj", "铃声", "片段",
           "live", "remix", "抖音", "0.8x", "降调", "翻自", "填词",
           "朗读", "念白", "朗诵", "诵读", "有声", "电台", "配音", "睡前", "助眠", "AI", "虚拟")

    def score(s):
        name = (s.get("name") or "").lower()
        base = re.sub(r"[（(].*?[)）]", "", name).strip()
        artists = " ".join(a.get("name", "") for a in (s.get("artists") or [])).lower()
        v = 0
        if name == ql or base == ql:
            v += 120
        if ql and (ql in name or (base and base in ql)):
            v += 50
        if ag and ag in artists:
            v += 120          # 点名歌手且对上 → 强烈优先原唱
        elif ag and artists:
            v -= 80           # 点名歌手但对不上 → 基本排除
        if ql in artists:
            v += 20
        if any(b in name for b in BAD):
            v -= 90
        return v

    return sorted(songs, key=score, reverse=True)[:n]


def _loudness_curve(wav_path):
    import wave
    import array
    import math
    with wave.open(wav_path, "rb") as w:
        rate, n = w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    samples = array.array("h")
    samples.frombytes(raw)
    curve = []
    for i in range(0, len(samples), rate):
        chunk = samples[i:i + rate]
        if not chunk:
            break
        s = sum(v * v for v in chunk)
        curve.append(math.sqrt(s / len(chunk)))
    return curve


def chorus_start(mp3_path, clip):
    wav = mp3_path + ".probe.wav"
    try:
        subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", mp3_path, "-ac", "1",
                        "-ar", "8000", wav], timeout=120, check=True)
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


def fetch_song_clip(song):
    """下载并切出副歌 15 秒（44.1k 立体声，给 demucs 用）。优先 320k 直链，失败退回外链。"""
    os.makedirs(TMP, exist_ok=True)
    sid = song["id"]
    raw = os.path.join(TMP, f"{sid}.mp3")
    data = b""
    h0 = {"user-agent": UA, "referer": "https://music.163.com/"}
    ck = _cookie()
    if ck:
        h0["cookie"] = ck
    for attempt in range(3):
        direct = song_url(sid)
        if not direct:
            time.sleep(0.8)
            continue
        try:
            with urllib.request.urlopen(urllib.request.Request(direct, headers=h0), timeout=60) as r:
                data = r.read()
        except Exception as e:
            logger.warning(f"[sing] 直链下载失败 sid={sid} 第{attempt + 1}次: {type(e).__name__}: {str(e)[:100]}")
            data = b""
        if len(data) >= 200_000:
            break
        time.sleep(0.8)
    if len(data) < 200_000:
        try:
            with _get(f"https://music.163.com/song/media/outer/url?id={sid}.mp3", timeout=60) as r:
                ctype = r.headers.get("content-type", "")
                data = r.read()
            if "audio" not in ctype:
                data = b""
        except Exception as e:
            logger.warning(f"[sing] 外链也失败 sid={sid}: {type(e).__name__}: {str(e)[:100]}")
            data = b""
    if len(data) < 200_000:
        raise RuntimeError("这首拿不到（会员曲/已下架）")
    with open(raw, "wb") as f:
        f.write(data)

    # 会员曲没版权时可能只给 30 秒试听，整首太短就别唱
    try:
        pr = subprocess.run([FFMPEG.replace("ffmpeg.exe", "ffprobe.exe"), "-v", "error",
                             "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", raw],
                            capture_output=True, timeout=60)
        full = float((pr.stdout or b"0").decode().strip() or 0)
    except Exception:
        full = 0.0
    if 0 < full < 25:
        logger.warning(f"[sing] 只有 {full:.1f}s（试听片段）sid={sid}")
        raise RuntimeError(f"只有 {full:.0f} 秒试听")

    start = chorus_start(raw, CLIP_SECONDS)
    clip = os.path.join(TMP, f"{sid}-clip44.wav")
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-ss", f"{start:.1f}", "-t", str(CLIP_SECONDS),
                    "-i", raw, "-ar", "44100", "-ac", "2", clip], timeout=180, check=True)
    try:
        os.remove(raw)
    except Exception:
        pass
    return clip


class SpokenSource(Exception):
    """源人声是念白/朗读（pipeline 以退出码 2 标记），这首跳过。"""


def sing_pipeline(clip_wav, out_wav, steps=STEPS):
    env = dict(os.environ)
    env.update({
        "HF_ENDPOINT": "https://hf-mirror.com",
        "HF_HOME": r"D:\hf-cache",
        "TRANSFORMERS_OFFLINE": "1",
        "TORCH_HOME": r"D:\torch-cache",
        "PYTHONIOENCODING": "utf-8",
    })
    r = subprocess.run([SVC_PY, PIPELINE, "--input", clip_wav, "--reference", REF_AUDIO,
                        "--out", out_wav, "--steps", str(steps)],
                       timeout=600, env=env,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if r.returncode == 2:
        raise SpokenSource()
    if r.returncode != 0:
        raise RuntimeError(f"变声失败（code {r.returncode}）")
    return out_wav


def quota_ok(uid):
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
        return False, f"你今天点我唱 {PER_USER_DAILY} 首了"
    if total >= GLOBAL_DAILY:
        return False, "今天唱歌额度用完了"
    rec["n"] += 1
    st[uid] = rec
    st = {k: v for k, v in st.items() if v.get("date") == today}
    try:
        json.dump(st, open(STATE, "w", encoding="utf-8"), ensure_ascii=False)
    except Exception:
        pass
    return True, ""


@register("sing", "local", "唱歌", "2.3.0")
class Sing(Star):
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)
        self._busy = asyncio.Lock()

    @filter.event_message_type(filter.EventMessageType.ALL)
    async def on_message(self, event: AstrMessageEvent):
        q = parse_song(event.message_str or "")
        if q is None:
            return
        q = q or "晴天"
        uid = str(event.get_sender_id())

        ok, why = quota_ok(uid)
        if not ok:
            yield event.plain_result(why + "。")
            return
        if self._busy.locked():
            yield event.plain_result("还在弄上一首，等我一下。")
            return

        async with self._busy:
            yield event.plain_result("在准备（分离人声 + 变声），大概半分钟到一分钟，别急。")
            try:
                artist_guess, title = split_query(q)
                # 只搜「歌名」往往比「歌手+歌名」能搜到更多可下载版本：
                # 实测「周杰伦的告白气球」搜出来全是 404 的 Cover，去掉歌手搜就有能放的。
                songs = await asyncio.to_thread(search, q)
                if artist_guess and title and title != q:
                    extra = await asyncio.to_thread(search, title)
                    seen = {s.get("id") for s in songs}
                    songs += [s for s in extra if s.get("id") not in seen]
                if not songs:
                    yield event.plain_result(f"没搜到「{q}」。")
                    return
                song, out44, skipped = None, None, 0
                for c in rank(songs, q, 12):
                    try:
                        clip = await asyncio.to_thread(fetch_song_clip, c)
                    except Exception:
                        continue
                    target = os.path.join(TMP, f"sing_{int(time.time())}.wav")
                    try:
                        await asyncio.to_thread(sing_pipeline, clip, target)
                        song, out44 = c, target
                        break
                    except SpokenSource:
                        skipped += 1
                        logger.info(f"[sing] 跳过念白版：{c.get('name')} / "
                                    f"{'/'.join(a.get('name', '') for a in (c.get('artists') or []))}")
                        continue
                    except Exception as e:
                        logger.warning(f"[sing] 候选失败 {c.get('name')}: {e}")
                        continue
                if not song or not out44:
                    why = "都是念白/朗读版" if skipped else "都拿不到（多半是会员曲）"
                    yield event.plain_result(f"「{q}」我找到的{why}，换一首试试。")
                    return

                name = song.get("name") or q
                artists = "/".join(a.get("name", "") for a in (song.get("artists") or []))
                note = ""
                if artist_guess and artist_guess not in artists:
                    note = f"（没找到{artist_guess}本人唱的，这段是{artists}的版本）"
                out16 = out44.replace(".wav", "-16k.wav")
                subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", out44, "-ac", "1",
                                "-ar", "16000", "-c:a", "pcm_s16le", out16], timeout=120, check=True)
                yield event.chain_result([
                    Plain(text=f"《{name}》— {artists}{note}，原曲的调子，我的声音（15 秒）："),
                    Record.fromFileSystem(out16),
                ])
                logger.info(f"[sing] ok uid={uid} {name}/{artists} skipped_spoken={skipped}")
            except Exception as e:
                logger.warning(f"[sing] fail: {e}")
                yield event.plain_result(f"没唱成：{str(e)[:80]}")
