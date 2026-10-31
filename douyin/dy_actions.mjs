// 抖音互动（真实 DOM 版，2026-10-23 实测）。
//
// 关键教训：推荐流是「多条 feed-item 叠成一列」，同一时刻 DOM 里至少有两条视频的
// 点赞/评论按钮，querySelector 会拿到屏幕外那条 —— 所以所有取元素都必须先筛「在视口内」。
//
//   node dy_actions.mjs --state                 读当前视频 + 点赞状态
//   node dy_actions.mjs --like [--yes]          点赞（已赞则跳过；dry-run 默认）
//   node dy_actions.mjs --comment "文案" [--yes] [--no-send]
//   node dy_actions.mjs --quota                 今日额度
import fs from 'node:fs'
import path from 'node:path'
import { ensureBrowser, connectPage } from './dy.mjs'

const HOME = 'D:\\AstrBot\\douyin'
const STATE = path.join(HOME, 'state.json')
const LOG = path.join(HOME, 'actions.jsonl')
const LIKE_DAILY = 30
const COMM_DAILY = 6
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const jitter = (a, b) => a + Math.floor(Math.random() * (b - a))
const today = () => new Date().toLocaleDateString('sv-SE')

const PICK = `(sel) => {
  const els = [...document.querySelectorAll(sel)]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth)
    .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)
  return els.length ? els[0].el : null
}`

const STATE_JS = `(() => {
  const pick = ${PICK}
  // 2026-10-26 改版：真播放器 video 是 0x0，按尺寸挑会挑空 → 按 currentSrc 挑
  const vids = [...document.querySelectorAll('video')]
  const vid = vids.find((x) => x.currentSrc && x.duration > 0) || vids.find((x) => x.currentSrc) || vids[0] || null
  const digg = pick('[data-e2e="video-player-digg"]')
  const txt = (s) => { const e = document.querySelector(s); return e ? (e.innerText || '').trim() : '' }
  let author = txt('[data-e2e="feed-video-nickname"]')
  let desc = txt('[data-e2e="video-desc"]').replace(/\\n+/g, ' ')
  if (!author || !desc) {
    const box = document.querySelector('[data-e2e="feed-active-video"]')
    const lines = box ? (box.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean) : []
    author = author || (lines.find((l) => l.startsWith('@')) || '').replace(/^@/, '').split(/\\s/)[0]
    desc = desc || (lines.find((l) => l.length > 6 && !l.startsWith('@')) || '')
  }
  return {
    url: location.href,
    author: author.replace(/^@/, '').split(/\\s/)[0],
    desc: (desc || '').slice(0, 160),
    duration: vid ? Math.round(vid.duration || 0) : 0,
    paused: vid ? vid.paused : null,
    diggState: digg ? digg.getAttribute('data-e2e-state') : '',
    diggText: digg ? (digg.innerText || '').trim().slice(0, 10) : '',
    vw: innerWidth, vh: innerHeight,
  }
})()`

const isLiked = (s) => /digged/.test(s || '') && !/no-digged/.test(s || '')

function loadState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return {} } }
function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)) }
function quota() {
  const s = loadState()
  if (!s[today()]) s[today()] = { likes: 0, comments: 0 }
  return s
}
function logAction(rec) { fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n') }

async function rectInView(cdp, sel) {
  return await cdp.eval(`(() => {
    const pick = ${PICK}
    const el = pick(${JSON.stringify(sel)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  })()`)
}

async function realClick(cdp, rect, fracX = 0.5) {
  const cx = rect.x + Math.round(rect.w * fracX)
  const cy = rect.y + Math.round(rect.h / 2)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 })
  return { cx, cy }
}

async function panelOpen(cdp) {
  return await cdp.eval(`(() => {
    const pick = ${PICK}
    const box = pick('.comment-input-container')
    const items = [...document.querySelectorAll('[data-e2e="comment-item"]')]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 100 && r.right > 0 && r.right <= innerWidth + 5 })
    return !!box && box.getBoundingClientRect().width > 200 && items.length > 0
  })()`)
}

async function ensurePanel(cdp) {
  if (await panelOpen(cdp)) return true
  const r = await rectInView(cdp, '[data-e2e="feed-comment-icon"]')
  if (!r) { console.log('视口里没有评论按钮'); return false }
  await realClick(cdp, r)
  for (let i = 0; i < 12; i++) {
    await sleep(600)
    if (await panelOpen(cdp)) return true
  }
  return false
}

async function focusInput(cdp) {
  const r = await rectInView(cdp, '.comment-input-container')
  if (!r) return false
  await realClick(cdp, r, 0.3)
  await sleep(1200)
  return await cdp.eval(`(() => {
    const a = document.activeElement
    if (!a) return { ok: false }
    return { ok: a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.isContentEditable, tag: a.tagName, ce: a.isContentEditable }
  })()`)
}

const main = async () => {
  const argv = process.argv.slice(2)
  const mode = argv.find((a) => a.startsWith('--')) || '--state'
  const yes = argv.includes('--yes')
  const noSend = argv.includes('--no-send')

  if (mode === '--quota') {
    const s = quota()
    console.log(JSON.stringify({ date: today(), ...s[today()], limits: { likes: LIKE_DAILY, comments: COMM_DAILY } }, null, 2))
    return
  }

  await ensureBrowser()
  const { cdp } = await connectPage()
  try {
    if (mode === '--state') {
      console.log(JSON.stringify(await cdp.eval(STATE_JS), null, 2))
      return
    }

    if (mode === '--like') {
      const st = quota()
      if (st[today()].likes >= LIKE_DAILY) { console.log('今天点赞额度用完了'); return }
      const before = await cdp.eval(STATE_JS)
      if (isLiked(before.diggState)) { console.log('这条已经赞过了', before.author); return }
      const r = await rectInView(cdp, '[data-e2e="video-player-digg"]')
      if (!r) { console.log('视口里没有点赞按钮'); return }
      if (!yes) { console.log('（dry-run）会点:', JSON.stringify(r), '|', before.author); return }
      await sleep(jitter(1500, 4000))
      await realClick(cdp, r)
      await sleep(1800)
      const after = await cdp.eval(STATE_JS)
      const ok = isLiked(after.diggState)
      if (ok) { st[today()].likes += 1; saveState(st); logAction({ action: 'like', author: before.author, desc: before.desc }) }
      console.log(ok ? `✅ 点赞成功：${before.author}` : `⚠️ 点了但状态没变：${after.diggState}`)
      return
    }

    if (mode === '--comment') {
      const text = argv[argv.indexOf('--comment') + 1]
      if (!text) { console.log('要给文案'); return }
      const st = quota()
      if (st[today()].comments >= COMM_DAILY) { console.log('今天评论额度用完了'); return }
      const info = await cdp.eval(STATE_JS)
      const opened = await ensurePanel(cdp)
      console.log('评论抽屉:', opened)
      if (!opened) return
      const focused = await focusInput(cdp)
      console.log('聚焦输入框:', JSON.stringify(focused))
      if (!focused || !focused.ok) { console.log('没聚焦上'); return }
      await cdp.eval(`(() => {
        const a = document.activeElement
        if (!a) return false
        if (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') { a.value = ''; a.dispatchEvent(new Event('input', { bubbles: true })); return true }
        const sel = window.getSelection(); const r = document.createRange()
        r.selectNodeContents(a); sel.removeAllRanges(); sel.addRange(r)
        document.execCommand('delete', false)
        a.dispatchEvent(new InputEvent('input', { bubbles: true }))
        return true
      })()`)
      await sleep(400)
      // Draft.js 编辑器用 execCommand 比 CDP insertText 稳（后者有时插不进去）
      const inserted = await cdp.eval(`(() => {
        const a = document.activeElement
        if (!a) return false
        a.focus()
        const ok = document.execCommand('insertText', false, ${JSON.stringify(text)})
        a.dispatchEvent(new InputEvent('input', { bubbles: true }))
        return ok
      })()`)
      console.log('execCommand 插入:', inserted)
      await sleep(800)
      const typed = await cdp.eval(`(() => { const a = document.activeElement; return a ? (a.value !== undefined ? a.value : a.innerText) : '' })()`)
      console.log('输入框内容:', JSON.stringify(typed))
      if (String(typed).trim() !== text.trim()) { console.log('⚠️ 内容和目标不一致，放弃发送'); return }
      if (noSend) { console.log('（--no-send，没发送）'); return }
      if (!yes) { console.log('（dry-run，未发送）'); return }
      // 发送按钮：抽屉里的「发送」是右侧的图标按钮（SVG），不是弹幕区那个文字按钮。
      // 策略：先找抽屉容器内文本为「发送」的元素；找不到就点抽屉最右那个图标按钮。
      const sendRect = await cdp.eval(`(() => {
        const box = [...document.querySelectorAll('.comment-input-container')]
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 200 && r.bottom > 0 && r.top < innerHeight)
          .sort((a, b) => b.r.width - a.r.width)[0]
        if (!box) return null
        const br = box.r
        const inner = [...box.el.querySelectorAll('span, svg, button, div')]
          .map((el) => ({ el, r: el.getBoundingClientRect(), t: (el.innerText || '').trim() }))
          .filter(({ r }) => r.width >= 16 && r.height >= 16 && r.width <= 120 && r.bottom > 0)
        const byText = inner.filter((o) => o.t === '发送').sort((a, b) => a.r.width - b.r.width)[0]
        if (byText) return { x: Math.round(byText.r.x), y: Math.round(byText.r.y), w: Math.round(byText.r.width), h: Math.round(byText.r.height), via: 'text' }
        const icons = inner.filter((o) => o.r.x > br.x + br.width * 0.6).sort((a, b) => b.r.x - a.r.x)
        if (!icons.length) return null
        const pick = icons[0]
        return { x: Math.round(pick.r.x), y: Math.round(pick.r.y), w: Math.round(pick.r.width), h: Math.round(pick.r.height), via: 'icon' }
      })()`)
      if (!sendRect) { console.log('没找到发送按钮'); return }
      await realClick(cdp, sendRect)
      await sleep(2000)
      const cleared = await cdp.eval(`(() => { const a = document.activeElement; const v = a ? (a.value !== undefined ? a.value : a.innerText) : ''; return !v || v.trim() === '' })()`)
      if (cleared) { st[today()].comments += 1; saveState(st) }
      logAction({ action: 'comment', author: info.author, desc: info.desc, text, cleared })
      console.log(cleared ? `✅ 已发送评论：${text}` : `⚠️ 点了发送但输入框没清空：${text}`)
      return
    }
  } finally {
    cdp.close()
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
