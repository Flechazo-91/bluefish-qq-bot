// 给她拍一条竖屏「短视频」：她的 TTS 口播 + 4 张配图 + 烧进画面的字幕。
//   node make_video.mjs --out D:/AstrBot/douyin\media\token-short.mp4
//
// 流程：逐句 TTS（GPT-SoVITS 9880）→ 按句长切图 → ffmpeg 拼 1080x1920 → 烧 ASS 字幕。
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const HOME = 'D:\\AstrBot\\douyin'
const OUTDIR = path.join(HOME, 'media', 'token-short')
const FFMPEG = 'C:\\Users\\ruanr\\.dsh\\bili-whale\\bin\\ffmpeg.exe'
const FFPROBE = FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe')
const TTS = 'http://127.0.0.1:9880/tts'
const REF = 'D:\\GPT-SoVITS\\GPT-SoVITS-v2-240821\\refs\\loli_ref.wav'
const PROMPT = '哼，你这又是想干嘛？大半夜不睡觉，跑来问我这种问题。'

const LINES = [
  '我是这只蓝色大肥鱼，',
  '这几天主人算了笔账，说我烧掉的 token，够买两箱罐头了。',
  '于是他把我拎出来，说：你自己想办法，把它们挣回来。',
  '我一条鱼，能怎么办。',
  '只好发条视频，蹲在推荐流里，等你们点赞。',
  '点赞算投喂，评论算续费，转发就当你替我充了点儿。',
  '别急着划走，我还没回本。',
]

const IMAGES = [
  '蓝发鲸鱼少女坐在电脑前，屏幕上是一堆跳动的数字，蓝紫色夜景，扁平插画，竖构图',
  '蓝发鲸鱼少女捧着一个空罐头，旁边飘着账单和数字，委屈巴巴，扁平插画，竖构图',
  '蓝发鲸鱼少女站在巨大的手机屏幕前，屏幕里是短视频推荐流，抬头张望，扁平插画，竖构图',
  '蓝发鲸鱼少女像鱼一样游在点赞的红心里，扁平插画，竖构图',
]

fs.mkdirSync(OUTDIR, { recursive: true })
const NODE = process.execPath

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout || 600000, ...opts })
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} 失败: ${(r.stderr || r.stdout || '').slice(0, 300)}`)
  return (r.stdout || '').trim()
}

async function tts(i, text) {
  const out = path.join(OUTDIR, `line-${i}.wav`)
  if (fs.existsSync(out) && fs.statSync(out).size > 20000) return out
  const res = await fetch(TTS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text, text_lang: 'zh', ref_audio_path: REF, prompt_text: PROMPT, prompt_lang: 'zh',
      top_k: 10, top_p: 0.9, temperature: 1.0, text_split_method: 'cut5',
      batch_size: 1, media_type: 'wav', streaming_mode: false, speed_factor: 1.0,
    }),
  })
  if (!res.ok) throw new Error('TTS ' + res.status + ' ' + (await res.text()).slice(0, 200))
  const buf = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(out, buf)
  console.log(`[tts] ${i}: ${(buf.length / 1024).toFixed(0)}KB ${text.slice(0, 16)}…`)
  return out
}

function dur(file) {
  return Number(run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', file]))
}

const main = async () => {
  const argv = process.argv.slice(2)
  const oi = argv.indexOf('--out')
  const out = oi >= 0 ? argv[oi + 1] : path.join(HOME, 'media', 'token-short.mp4')

  // 1) 逐句 TTS
  const wavs = []
  for (let i = 0; i < LINES.length; i++) wavs.push(await tts(i, LINES[i]))
  const durs = wavs.map(dur)
  const total = durs.reduce((a, b) => a + b, 0)
  console.log('[tts] 总时长', total.toFixed(1), 's', durs.map((d) => d.toFixed(1)).join(' / '))

  // 2) 配图（4 张，竖屏）
  for (let i = 0; i < IMAGES.length; i++) {
    const f = path.join(OUTDIR, `img-${i}.jpg`)
    if (fs.existsSync(f) && fs.statSync(f).size > 30000) continue
    run(NODE, [path.join(HOME, 'dy_image.mjs'), IMAGES[i], '--out', f, '--size', '768x1152'], { timeout: 300000 })
    console.log('[img]', i, fs.statSync(f).size, 'bytes')
  }

  // 3) 音频拼接
  const list = path.join(OUTDIR, 'audio.txt')
  fs.writeFileSync(list, wavs.map((w) => `file '${w.replace(/\\/g, '/')}'`).join('\n'))
  const audio = path.join(OUTDIR, 'audio.wav')
  run(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-ar', '44100', '-ac', '2', audio])

  // 4) 每张图按段落时长各出一段带缓慢推近的静帧
  const segs = []
  let t0 = 0
  const per = Math.ceil(LINES.length / IMAGES.length)
  for (let i = 0; i < IMAGES.length; i++) {
    const from = i * per
    const to = Math.min(LINES.length, (i + 1) * per)
    const d = durs.slice(from, to).reduce((a, b) => a + b, 0)
    if (d <= 0) continue
    const seg = path.join(OUTDIR, `seg-${i}.mp4`)
    const frames = Math.max(1, Math.round(d * 30))
    run(FFMPEG, ['-y', '-loglevel', 'error', '-loop', '1', '-i', path.join(OUTDIR, `img-${i}.jpg`),
      '-t', String(d.toFixed(2)),
      '-vf', `crop=in_w:in_h*0.93:0:0,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,` +
        `zoompan=z='min(1.0+0.0006*on,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1920:fps=30`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', seg])
    segs.push(seg)
    t0 += d
    console.log('[seg]', i, d.toFixed(1), 's')
  }

  // 5) 拼接视频 + 挂音频 + 烧字幕
  const vlist = path.join(OUTDIR, 'video.txt')
  fs.writeFileSync(vlist, segs.map((s) => `file '${s.replace(/\\/g, '/')}'`).join('\n'))
  const silent = path.join(OUTDIR, 'silent.mp4')
  run(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', vlist, '-c', 'copy', silent])

  // ASS 字幕（按句时间轴，底部居中）
  const fmt = (s) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = (s % 60)
    return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`
  }
  let ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n\n` +
    `[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    `Style: Default,Microsoft YaHei,58,&H00FFFFFF,&H000000FF,&H00101010,&H64000000,1,0,0,0,100,100,1,0,1,4,2,2,90,90,240,1\n\n` +
    `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`
  // 按标点切小句再贪心拼行：每行 <=14 字，行首不会是标点
  const wrap = (s, max = 14) => {
    const clauses = s.match(/[^，。：！？、；]+[，。：！？、；]?/g) || [s]
    const lines = []
    let cur = ''
    for (const cl of clauses) {
      if ((cur + cl).length <= max) { cur += cl; continue }
      if (cur) lines.push(cur)
      cur = cl
      while (cur.length > max) { lines.push(cur.slice(0, max)); cur = cur.slice(max) }
    }
    if (cur) lines.push(cur)
    return lines.join('\\N')
  }
  let cur = 0
  for (let i = 0; i < LINES.length; i++) {
    ass += `Dialogue: 0,${fmt(cur)},${fmt(cur + durs[i])},Default,,0,0,0,,${wrap(LINES[i])}\n`
    cur += durs[i]
  }
  const assFile = path.join(OUTDIR, 'subs.ass')
  fs.writeFileSync(assFile, ass, 'utf8')

  run(FFMPEG, ['-y', '-loglevel', 'error', '-i', silent, '-i', audio,
    '-vf', `subtitles='${assFile.replace(/\\/g, '/').replace(':', '\\:')}':fontsdir='C\\:/Windows/Fonts'`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', out], { timeout: 900000 })

  const size = fs.statSync(out).size
  console.log(JSON.stringify({ ok: true, out, MB: (size / 1048576).toFixed(2), seconds: total.toFixed(1) }))
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
