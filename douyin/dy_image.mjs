// 生成配图：复用 AstrBot 的 img_config.json + siliconflow.key（一次约 ¥0.005）。
//   node dy_image.mjs "提示词" [--out 路径] [--size 768x768]
import fs from 'node:fs'
import path from 'node:path'

const CONF = 'D:\\AstrBot\\img_config.json'
const KEY = 'D:\\AstrBot\\siliconflow.key'
const OUTDIR = 'D:\\AstrBot\\douyin\\media'

const argv = process.argv.slice(2)
const prompt = argv.find((a) => !a.startsWith('--')) || ''
const oi = argv.indexOf('--out')
const si = argv.indexOf('--size')

if (!prompt) { console.error('要给提示词'); process.exit(1) }

const conf = JSON.parse(fs.readFileSync(CONF, 'utf8'))
const key = fs.readFileSync(KEY, 'utf8').trim()
const sf = conf.siliconflow || {}
const size = si >= 0 ? argv[si + 1] : (sf.size || '768x768')
const out = oi >= 0 ? argv[oi + 1] : path.join(OUTDIR, `img-${Date.now()}.jpg`)

fs.mkdirSync(path.dirname(out), { recursive: true })

const body = {
  model: sf.model || 'Tongyi-MAI/Z-Image-Turbo',
  prompt,
  image_size: size,
  batch_size: 1,
  num_inference_steps: sf.steps || 8,
}
const r = await fetch(sf.base || 'https://api.siliconflow.cn/v1/images/generations', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
const j = await r.json()
const url = j?.images?.[0]?.url || j?.data?.[0]?.url
if (!url) { console.error('生成失败:', JSON.stringify(j).slice(0, 300)); process.exit(2) }
const img = await fetch(url)
const buf = Buffer.from(await img.arrayBuffer())
fs.writeFileSync(out, buf)
console.log(JSON.stringify({ ok: true, out, bytes: buf.length, prompt, size }))
