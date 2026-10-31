// 给示例好友唱一首情歌：TTS 说一句引子 + 她唱的副歌，拼成一条语音发过去。
//   node sing_for.mjs --to 1000003 --song "告白气球"
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const TOKEN = 'YOUR_ONEBOT_TOKEN'
const FFMPEG = 'C:\\Users\\ruanr\\.dsh\\bili-whale\\bin\\ffmpeg.exe'
const TMP = 'D:\\AstrBot\\data\\temp\\sing'
const REF = 'D:\\GPT-SoVITS\\GPT-SoVITS-v2-240821\\refs\\loli_ref.wav'
const PROMPT = '哼，你这又是想干嘛？大半夜不睡觉，跑来问我这种问题。'
const PY = 'C:\\Users\\ruanr\\AppData\\Roaming\\uv\\tools\\astrbot\\Scripts\\python.exe'

const argv = process.argv.slice(2)
const val = (n, d = '') => { const i = argv.indexOf(n); return i >= 0 ? (argv[i + 1] || d) : d }
const to = Number(val('--to', '1000003'))
const songs = val('--song', '告白气球,小幸运,甜甜的,小情歌,私奔到月球').split(',').map((s) => s.trim())
const lead = val('--lead', '示例好友，信写完了，还差一首歌。这首，唱给你。')

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 900000, ...opts })
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} 失败: ${(r.stderr || r.stdout || '').slice(0, 300)}`)
  return (r.stdout || '').trim()
}

const pyScript = String.raw`
import sys, os, json
sys.path.insert(0, r"D:/AstrBot/data\plugins\astrbot_plugin_sing")
import main as S

songs = json.loads(sys.argv[1])
out = sys.argv[2]
last = ""
for q in songs:
    try:
        cands = S.rank(S.search(q), q, 8)
    except Exception as e:
        last = f"search {q}: {e}"
        continue
    for c in cands:
        try:
            clip = S.fetch_song_clip(c)
        except Exception as e:
            last = f"fetch {c.get('name')}: {e}"
            continue
        try:
            S.sing_pipeline(clip, out)
            print(json.dumps({"ok": True, "song": c.get("name"), "artist": "/".join(a.get("name","") for a in (c.get("artists") or []))}, ensure_ascii=False))
            sys.exit(0)
        except S.SpokenSource:
            last = f"spoken {c.get('name')}"
            continue
        except Exception as e:
            last = f"pipeline {c.get('name')}: {e}"
            continue
print(json.dumps({"ok": False, "why": last}, ensure_ascii=False))
sys.exit(1)
`

async function tts(text, out) {
  const res = await fetch('http://127.0.0.1:9880/tts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text, text_lang: 'zh', ref_audio_path: REF, prompt_text: PROMPT, prompt_lang: 'zh',
      top_k: 10, top_p: 0.9, temperature: 1.0, text_split_method: 'cut5',
      batch_size: 1, media_type: 'wav', streaming_mode: false, speed_factor: 1.0,
    }),
  })
  if (!res.ok) throw new Error('TTS ' + res.status)
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()))
  return out
}

const main = async () => {
  fs.mkdirSync(TMP, { recursive: true })
  const songWav = path.join(TMP, `forsing_${Date.now()}.wav`)
  console.log('[sing]', songs.join(' / '))
  const r = run(PY, ['-c', pyScript, JSON.stringify(songs), songWav])
  const res = JSON.parse(r.trim().split('\n').pop())
  if (!res.ok) { console.error('没唱成:', res.why); process.exit(2) }
  console.log('[sing] OK', res.song, '/', res.artist, (fs.statSync(songWav).size / 1024).toFixed(0) + 'KB')

  const leadWav = path.join(TMP, `lead_${Date.now()}.wav`)
  await tts(lead, leadWav)
  console.log('[tts] 引子', (fs.statSync(leadWav).size / 1024).toFixed(0) + 'KB')

  // 拼成 16k 单声道（QQ 对 44.1k 立体声 wav 会「无法播放」）
  const out = path.join(TMP, `letter-song_${Date.now()}.wav`)
  run(FFMPEG, ['-y', '-loglevel', 'error', '-i', leadWav, '-i', songWav,
    '-filter_complex', '[0:a]aresample=16000,aformat=channel_layouts=mono[a0];[1:a]aresample=16000,aformat=channel_layouts=mono[a1];[a0][a1]concat=n=2:v=0:a=1[out]',
    '-map', '[out]', '-c:a', 'pcm_s16le', out])
  console.log('[mix]', out, (fs.statSync(out).size / 1024).toFixed(0) + 'KB')

  const fileUrl = 'file:///' + out.replace(/\\/g, '/')
  const send = await fetch('http://127.0.0.1:3000/', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ action: 'send_private_msg', params: { user_id: to, message: [{ type: 'record', data: { file: fileUrl } }] } }),
  })
  const j = await send.json()
  console.log('[send]', JSON.stringify(j).slice(0, 160))
  console.log(JSON.stringify({ song: res.song, artist: res.artist, file: out }))
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
