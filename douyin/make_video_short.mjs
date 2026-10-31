// 短版「魔性」短视频：~12 秒，3 句台词，配图带轻微跳动/摆动（仿 AI 魔性角色跳舞的节奏感）。
//   node make_video_short.mjs --out D:/AstrBot/douyin\media\token-short-cute.mp4
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const HOME = 'D:\\AstrBot\\douyin'
const IMG = path.join(HOME, 'media', 'token-cute')
const OUTDIR = path.join(HOME, 'media', 'token-short-cute')
const FFMPEG = 'C:\\Users\\ruanr\\.dsh\\bili-whale\\bin\\ffmpeg.exe'
const FFPROBE = FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe')
const TTS = 'http://127.0.0.1:9880/tts'
const REF = 'D:\\GPT-SoVITS\\GPT-SoVITS-v2-240821\\refs\\loli_ref.wav'
const PROMPT = '哼，你这又是想干嘛？大半夜不睡觉，跑来问我这种问题。'

const LINES = [
  '主人说我 token 烧太多，让我靠抖音挣回来。',
  '我一只鱼，只好出来卖个萌。',
  '点赞算投喂，划走算抛弃。',
]
// 三句分别用哪张图
const IMG_FOR = ['img-0-rgb.jpg', 'img-2-rgb.jpg', 'img-3-rgb.jpg']
const TITLE_SEC = 1.0
const FADE = 0.25

fs.mkdirSync(OUTDIR, { recursive: true })
const run = (cmd, args, timeout = 900000) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout })
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} 失败: ${(r.stderr || r.stdout || '').slice(0, 400)}`)
  return (r.stdout || '').trim()
}
const dur = (f) => Number(run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f]))

async function tts(i, text) {
  const out = path.join(OUTDIR, `line-${i}.wav`)
  if (fs.existsSync(out) && fs.statSync(out).size > 20000) return out
  const res = await fetch(TTS, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text, text_lang: 'zh', ref_audio_path: REF, prompt_text: PROMPT, prompt_lang: 'zh',
      top_k: 10, top_p: 0.9, temperature: 1.0, text_split_method: 'cut5',
      batch_size: 1, media_type: 'wav', streaming_mode: false, speed_factor: 1.05,
    }),
  })
  if (!res.ok) throw new Error('TTS ' + res.status)
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()))
  console.log('[tts]', i, text.slice(0, 14))
  return out
}

const main = async () => {
  const argv = process.argv.slice(2)
  const oi = argv.indexOf('--out')
  const out = oi >= 0 ? argv[oi + 1] : path.join(HOME, 'media', 'token-short-cute.mp4')

  const wavs = []
  for (let i = 0; i < LINES.length; i++) wavs.push(await tts(i, LINES[i]))
  const durs = wavs.map(dur)
  console.log('[tts] 配音', durs.map((d) => d.toFixed(1)).join(' / '), '总', durs.reduce((a, b) => a + b, 0).toFixed(1), 's')

  // 片头
  const titleSeg = path.join(OUTDIR, 'seg-title.mp4')
  run(FFMPEG, ['-y', '-loglevel', 'error', '-loop', '1', '-i', path.join(IMG, 'title-card.png'),
    '-t', String(TITLE_SEC), '-vf', `scale=1080:1920,fps=30`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', titleSeg])

  // 每段：轻微脉冲 + 摆动（像在跟着节拍晃）
  const segs = [titleSeg]
  for (let i = 0; i < LINES.length; i++) {
    const d = durs[i]
    const seg = path.join(OUTDIR, `seg-${i}.mp4`)
    const frames = Math.round(d * 30)
    // 每 0.5 秒一个拍子：缩放 1.00~1.05，旋转 ±2 度
    const zoom = `1.036+0.014*sin(2*PI*on/15)`
    run(FFMPEG, ['-y', '-loglevel', 'error', '-loop', '1', '-i', path.join(IMG, IMG_FOR[i]),
      '-t', String(d.toFixed(2)),
      '-vf', `crop=in_w:in_h*0.93:0:0,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,` +
        `zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1920:fps=30,` +
        `rotate='0.035*sin(2*PI*t/1.0)':ow=iw:oh=ih:c=white,` +
        `fade=in:st=0:d=${FADE},fade=out:st=${(d - FADE).toFixed(2)}:d=${FADE}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', seg])
    segs.push(seg)
    console.log('[seg]', i, d.toFixed(1), 's')
  }

  const vlist = path.join(OUTDIR, 'video.txt')
  fs.writeFileSync(vlist, segs.map((s) => `file '${s.replace(/\\/g, '/')}'`).join('\n'))
  const silent = path.join(OUTDIR, 'silent.mp4')
  run(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', vlist, '-c', 'copy', silent])

  // 音频：片头静音 + 三句（用 filter_complex，避免采样率不一致被截断）
  const blank = path.join(OUTDIR, 'silence.wav')
  run(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(TITLE_SEC), blank])
  const parts = [blank, ...wavs]
  const audio = path.join(OUTDIR, 'audio.wav')
  const args = ['-y', '-loglevel', 'error']
  for (const f of parts) args.push('-i', f)
  args.push('-filter_complex', parts.map((_, i) => `[${i}:a]`).join('') + `concat=n=${parts.length}:v=0:a=1[a]`,
    '-map', '[a]', '-ar', '44100', '-ac', '2', audio)
  run(FFMPEG, args)

  // 字幕
  const fmt = (s) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
    return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`
  }
  const wrap = (s, max = 13) => {
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
  let ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n\n` +
    `[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    `Style: Default,Microsoft YaHei,64,&H00FFFFFF,&H000000FF,&H00402010,&H64000000,1,0,0,0,100,100,1,0,1,4,3,2,90,90,260,1\n\n` +
    `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`
  let cur = TITLE_SEC
  for (let i = 0; i < LINES.length; i++) {
    ass += `Dialogue: 0,${fmt(cur)},${fmt(cur + durs[i])},Default,,0,0,0,,${wrap(LINES[i])}\n`
    cur += durs[i]
  }
  const assFile = path.join(OUTDIR, 'subs.ass')
  fs.writeFileSync(assFile, ass, 'utf8')

  run(FFMPEG, ['-y', '-loglevel', 'error', '-i', silent, '-i', audio,
    '-vf', `subtitles='${assFile.replace(/\\/g, '/').replace(':', '\\:')}':fontsdir='C\\:/Windows/Fonts'`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', out])

  console.log(JSON.stringify({ ok: true, out, MB: (fs.statSync(out).size / 1048576).toFixed(2), seconds: (TITLE_SEC + durs.reduce((a, b) => a + b, 0)).toFixed(1) }))
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
