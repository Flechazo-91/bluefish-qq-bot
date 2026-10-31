// 写一条抖音图文文案：先搜相关视频当参照，再让 DeepSeek 用「她自己」的口吻写描述（含话题标签）。
//   node dy_compose.mjs --kw deepseek [--json]
// 输出：{ desc, imagePrompts[] }
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const argv = process.argv.slice(2)
const val = (n, d = '') => { const i = argv.indexOf(n); return i >= 0 ? (argv[i + 1] || d) : d }
const kw = val('--kw', 'deepseek')
const asJson = argv.includes('--json')
const NODE = process.execPath

function search(kw) {
  try {
    const out = execFileSync(NODE, [path.join('D:\\AstrBot\\douyin', 'dy_search.mjs'), kw, '--json'], { encoding: 'utf8', timeout: 120000 })
    const start = out.indexOf('[')
    const end = out.lastIndexOf(']')
    if (start < 0 || end < 0) return []
    return JSON.parse(out.slice(start, end + 1)).map((x) => x.text).filter((t) => t.length > 20)
  } catch {
    return []
  }
}

const REFS = search(kw)
const refText = REFS.slice(0, 8).map((t, i) => `${i + 1}. ${t.slice(0, 120)}`).join('\n')

const { deepseekConf } = await import('./dy_llm.mjs')
const { key, base, model } = deepseekConf()

const sys = [
  '你是「一只蓝色大肥鱼qwq」，一个蓝发鲸鱼少女，在抖音发图文。',
  '性格：话不多、有点嘴硬、偶尔自嘲，喜欢短句，不卖萌堆表情。',
  '写作要求：正文 80~160 字；第一句就要有钩子；不要用「大家好」「今天给大家分享」这种套话；',
  '不要抄下面参照视频的标题；可以有 3~5 个话题标签（#开头），放在最后；',
  '不要提 AI 生成、不要带货、不要联系方式。',
  '另外给：一条标题（≤12 字，短促有钩子，不要书名号）和 1 条配图提示词（中文，20~40 字，适合文生图，不要出现文字）。',
  '只输出 JSON：{"title":"…","desc":"…","image":"…"}',
].join('')

const user = [
  `主题关键词：${kw}`,
  '下面是我刚在抖音搜到的同类热门视频（只作参照，别抄）：',
  refText || '（没搜到，自己发挥）',
  '写一条我要发的图文。',
].join('\n')

const r = await fetch(`${base}/chat/completions`, {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    temperature: 0.9,
    max_tokens: 500,
  }),
})
const j = await r.json()
let txt = j?.choices?.[0]?.message?.content || ''
txt = txt.replace(/^```(json)?/m, '').replace(/```$/m, '').trim()
let parsed
try { parsed = JSON.parse(txt) } catch {
  const m = txt.match(/\{[\s\S]*\}/)
  parsed = m ? JSON.parse(m[0]) : { desc: txt.slice(0, 200), image: '' }
}
const result = {
  kw,
  refs: REFS.length,
  title: (parsed.title || '').trim(),
  desc: (parsed.desc || '').trim(),
  image: (parsed.image || '').trim(),
}
if (asJson) console.log(JSON.stringify(result, null, 2))
else {
  console.log('参照条数:', result.refs)
  console.log('标题:', result.title)
  console.log('描述:\n' + result.desc)
  console.log('配图提示词:', result.image)
}
