// 可爱版短视频：萌系配图 + 粉色标题卡 + 交叉淡入淡出 + 原有她的配音/字幕。
//   node make_video_cute.mjs --out D:/AstrBot/douyin\media\token-cute.mp4
//
// 依赖：token-short 里已经生成好的 line-*.wav（台词配音），token-cute 里的 img-*.jpg / title-card.png
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const HOME = 'D:\\AstrBot\\douyin'
const AUD = path.join(HOME, 'media', 'token-short')     // 复用配音
const IMG = path.join(HOME, 'media', 'token-cute')
const OUTDIR = path.join(HOME, 'media', 'token-cute-render')
const FFMPEG = 'C:\\Users\\ruanr\\.dsh\\bili-whale\\bin\\ffmpeg.exe'
const FFPROBE = FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe')

const LINES = [
  '我是这只蓝色大肥鱼，',
  '这几天主人算了笔账，说我烧掉的 token，够买两箱罐头了。',
  '于是他把我拎出来，说：你自己想办法，把它们挣回来。',
  '我一条鱼，能怎么办。',
  '只好发条视频，蹲在推荐流里，等你们点赞。',
  '点赞算投喂，评论算续费，转发就当你替我充了点儿。',
  '别急着划走，我还没回本。',
]
const TITLE_SEC = 2.2
const FADE = 0.35

fs.mkdirSync(OUTDIR, { recursive: true })

function run(cmd, args, timeout = 900000) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout })
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} 失败: ${(r.stderr || r.stdout || '').slice(0, 400)}`)
  return (r.stdout || '').trim()
}
const dur = (f) => Number(run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f]))

const main = async () => {
  const argv = process.argv.slice(2)
  const oi = argv.indexOf('--out')
  const out = oi >= 0 ? argv[oi + 1] : path.join(HOME, 'media', 'token-cute.mp4')

  const wavs = LINES.map((_, i) => path.join(AUD, `line-${i}.wav`))
  for (const w of wavs) if (!fs.existsSync(w)) throw new Error('缺配音: ' + w)
  const durs = wavs.map(dur)
  const speech = durs.reduce((a, b) => a + b, 0)
  console.log('[audio] 配音', speech.toFixed(1), 's + 片头', TITLE_SEC, 's')

  // 1) 片头卡（2.2 秒，轻微放大）
  const titleSeg = path.join(OUTDIR, 'seg-title.mp4')
  run(FFMPEG, ['-y', '-loglevel', 'error', '-loop', '1', '-i', path.join(IMG, 'title-card.png'),
    '-t', String(TITLE_SEC),
    '-vf', `scale=1080:1920,zoompan=z='min(1.0+0.0009*on,1.06)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.round(TITLE_SEC * 30)}:s=1080x1920:fps=30,fade=out:st=${(TITLE_SEC - FADE).toFixed(2)}:d=${FADE}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', titleSeg])

  // 2) 正文四段：裁掉底部水印、缓慢推近、首尾淡入淡出
  const per = Math.ceil(LINES.length / 4)
  const segs = [titleSeg]
  for (let i = 0; i < 4; i++) {
    const from = i * per
    const to = Math.min(LINES.length, (i + 1) * per)
    const d = durs.slice(from, to).reduce((a, b) => a + b, 0)
    if (d <= 0) continue
    const seg = path.join(OUTDIR, `seg-${i}.mp4`)
    run(FFMPEG, ['-y', '-loglevel', 'error', '-loop', '1', '-i', path.join(IMG, `img-${i}-rgb.jpg`),
      '-t', String(d.toFixed(2)),
      '-vf', `crop=in_w:in_h*0.93:0:0,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,` +
        `zoompan=z='min(1.0+0.0007*on,1.10)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.round(d * 30)}:s=1080x1920:fps=30,` +
        `fade=in:st=0:d=${FADE},fade=out:st=${(d - FADE).toFixed(2)}:d=${FADE}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', seg])
    segs.push(seg)
    console.log('[seg]', i, d.toFixed(1), 's')
  }

  // 3) 视频拼接
  const vlist = path.join(OUTDIR, 'video.txt')
  fs.writeFileSync(vlist, segs.map((s) => `file '${s.replace(/\\/g, '/')}'`).join('\n'))
  const silent = path.join(OUTDIR, 'silent.mp4')
  run(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', vlist, '-c', 'copy', silent])

  // 4) 音频：片头静音 + 配音
  const alist = path.join(OUTDIR, 'audio.txt')
  const blank = path.join(OUTDIR, 'silence.wav')
  run(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-t', String(TITLE_SEC), blank])
  // 用 filter_complex 拼接：GSV 出来的 wav 采样率/声道和静音段不一致，
  // concat 分离器会直接截断（上一版只拼出 12.2 秒）
  const audio = path.join(OUTDIR, 'audio.wav')
  const parts = [blank, ...wavs]
  const args = ['-y', '-loglevel', 'error']
  for (const f of parts) args.push('-i', f)
  args.push('-filter_complex', parts.map((_, i) => `[${i}:a]`).join('') + `concat=n=${parts.length}:v=0:a=1[a]`,
    '-map', '[a]', '-ar', '44100', '-ac', '2', audio)
  run(FFMPEG, args)

  // 5) ASS 字幕（时间轴整体后移片头）
  const fmt = (s) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
    return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`
  }
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
  let ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n\n` +
    `[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    `Style: Default,Microsoft YaHei,62,&H00FFFFFF,&H000000FF,&H00402010,&H64000000,1,0,0,0,100,100,1,0,1,4,3,2,90,90,250,1\n\n` +
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

  console.log(JSON.stringify({ ok: true, out, MB: (fs.statSync(out).size / 1048576).toFixed(2), seconds: (speech + TITLE_SEC).toFixed(1) }))
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
