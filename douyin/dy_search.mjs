// 抖音搜索：打开搜索页，抓视频卡的标题/作者/点赞（用于给发布内容找参照）。
//   node dy_search.mjs "deepseek"
//   node dy_search.mjs "deepseek" --json
import { ensureBrowser, connectPage } from './dy.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const kw = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'deepseek'
const asJson = process.argv.includes('--json')

const COLLECT = `(() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  const out = []
  const seen = new Set()
  for (const el of document.querySelectorAll('a[href*="/video/"], li, div')) {
    const t = (el.innerText || '').trim().replace(/\\n+/g, ' ')
    if (t.length < 8 || t.length > 300) continue
    const r = el.getBoundingClientRect()
    if (r.width < 150 || r.height < 80) continue
    const href = el.querySelector ? (el.querySelector('a[href*="/video/"]')?.getAttribute('href') || '') : ''
    const key = t.slice(0, 40)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ text: t.slice(0, 160), href, ...rect(el) })
    if (out.length >= 30) break
  }
  return out
})()`

const main = async () => {
  await ensureBrowser()
  const { cdp } = await connectPage()
  try {
    const url = `https://www.douyin.com/search/${encodeURIComponent(kw)}?type=video`
    await cdp.send('Page.navigate', { url })
    await sleep(9000)
    const info = await cdp.eval(`({ url: location.href, title: document.title, bodyLen: document.body.innerText.length })`)
    console.log('page:', JSON.stringify(info))
    const items = await cdp.eval(COLLECT)
    if (asJson) {
      console.log(JSON.stringify(items, null, 2))
    } else {
      console.log(`找到 ${items.length} 条候选：`)
      for (const it of items.slice(0, 15)) console.log(' -', it.text.slice(0, 90), '|', it.href.slice(0, 30))
    }
    const shot = `D:\\AstrBot\\douyin\\shots\\search-${Date.now()}.png`
    await cdp.screenshot(shot)
    console.log('shot:', shot)
  } finally {
    cdp.close()
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
