// 一键发抖音图文：搜同类视频当参照 → DeepSeek 写文案+配图提示 → 生成配图 → 发布。
//   node dy_post.mjs --kw deepseek                 走到「填好但不发」（dry-run）
//   node dy_post.mjs --kw deepseek --yes           真发
//   node dy_post.mjs --kw deepseek --text-only     只出文案，不生成图、不发布
//
// 依赖：dy_compose.mjs（选题+文案）、dy_image.mjs（配图）、dy_publish.mjs（发布）
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const HOME = 'D:\\AstrBot\\douyin'
const NODE = process.execPath
const argv = process.argv.slice(2)
const val = (n, d = '') => { const i = argv.indexOf(n); return i >= 0 ? (argv[i + 1] || d) : d }
// 没指定 --kw 就从 topics.txt 随机挑一个（避免每条都同一个词）
function pickKw() {
  try {
    const list = fs.readFileSync(path.join(HOME, 'topics.txt'), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    if (list.length) return list[Math.floor(Math.random() * list.length)]
  } catch { }
  return 'deepseek'
}
const kw = val('--kw', '') || pickKw()
const yes = argv.includes('--yes')
const textOnly = argv.includes('--text-only')

const run = (args, timeout = 5 * 60 * 1000) => {
  const r = execFileSync(NODE, args, { encoding: 'utf8', timeout })
  return r
}

// 1) 选题 + 文案
console.log('[1/3] 搜「' + kw + '」并写文案…')
const composeOut = run([path.join(HOME, 'dy_compose.mjs'), '--kw', kw, '--json'])
const start = composeOut.indexOf('{')
const composed = JSON.parse(composeOut.slice(start))
console.log('文案:\n' + composed.desc)
console.log('配图:', composed.image)
fs.writeFileSync(path.join(HOME, 'last-post.json'), JSON.stringify({ at: new Date().toISOString(), ...composed }, null, 2))

if (textOnly) { console.log('（--text-only，到此为止）'); process.exit(0) }

// 2) 配图
const img = path.join(HOME, 'media', `post-${Date.now()}.jpg`)
console.log('[2/3] 生成配图…')
const imgOut = run([path.join(HOME, 'dy_image.mjs'), composed.image || `${kw} 相关插画`, '--out', img, '--size', '768x1024'])
console.log(imgOut.trim())

// 3) 发布
const title = (composed.title || composed.desc || kw).replace(/[#\n].*$/s, '').slice(0, 20)
console.log('[3/3] 发布（' + (yes ? '真发' : 'dry-run') + '）…')
const args = [path.join(HOME, 'dy_publish.mjs'), '--images', img, '--title', title, '--desc', composed.desc]
if (yes) args.push('--yes')
console.log(run(args, 6 * 60 * 1000).slice(-600))

// 收尾：关掉调试用的 Edge（大肥鱼不出门的时候不该常驻）
try {
  const { spawnSync } = await import('node:child_process')
  spawnSync(process.execPath, [path.join(HOME, 'dy.mjs'), 'kill'], { stdio: 'ignore', timeout: 30000 })
} catch { }