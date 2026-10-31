// 抖音刷推荐流：真选择器版（2026-10-23 实测）。
//   node dy_feed.mjs --watch 5                 连看 5 条（每条 12~30 秒），记录到 watched.jsonl
//   node dy_feed.mjs --watch 5 --like          看的同时按概率点赞（受 state.json 配额限制）
//   node dy_feed.mjs --analyze                 只看当前这条
//
// 选择器：
//   [data-e2e="feed-active-video"]        当前视频容器
//   [data-e2e="video-player-digg"]        点赞（data-e2e-state: video-player-no-digged / video-player-is-digged）
//   [data-e2e="video-switch-next-arrow"]  下一条
//   [data-e2e="feed-video-nickname"] / [data-e2e="video-desc"]
import fs from 'node:fs'
import path from 'node:path'
import { ensureBrowser, connectPage } from './dy.mjs'

const HOME = 'D:\\AstrBot\\douyin'
const WATCHED = path.join(HOME, 'watched.jsonl')
const STATE = path.join(HOME, 'state.json')
const LIKE_DAILY = 30
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const jitter = (a, b) => a + Math.floor(Math.random() * (b - a))
const today = () => new Date().toLocaleDateString('sv-SE')

const READ_JS = `(() => {
  const q = (s) => document.querySelector(s)
  // 2026-10-26 改版：真正的播放器 video 是 0x0（外面套了个可见的占位层），
  // 所以不能再按「尺寸>0」挑，要按「有 currentSrc / 有 duration」挑。
  const vids = [...document.querySelectorAll('video')]
  const v = vids.find((x) => x.currentSrc && x.duration > 0) || vids.find((x) => x.currentSrc) || vids[0] || null
  const digs = [...document.querySelectorAll('[data-e2e="video-player-digg"]')]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.bottom > 0 && r.top < innerHeight && r.width > 4)
    .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)
  const digg = digs.length ? digs[0].el : q('[data-e2e="video-player-digg"]')
  const txt = (s) => { const e = q(s); return e ? (e.innerText || '').trim() : '' }
  return {
    url: location.href,
    author: txt('[data-e2e="feed-video-nickname"]'),
    desc: txt('[data-e2e="video-desc"]').replace(/\\n+/g, ' ').slice(0, 150),
    duration: v ? Math.round(v.duration || 0) : 0,
    current: v ? Math.round(v.currentTime || 0) : 0,
    paused: v ? v.paused : null,
    diggState: digg ? digg.getAttribute('data-e2e-state') : '',
    diggText: digg ? (digg.innerText || '').trim().slice(0, 10) : '',
    src: v ? (v.currentSrc || v.src || '').slice(-40) : '',
  }
})()`

async function play(cdp) {
  return await cdp.eval(`(() => {
    const vids = [...document.querySelectorAll('video')]
    const v = vids.find((x) => x.currentSrc) || vids[0]
    if (!v) return false
    v.muted = true
    v.play()
    return true
  })()`)
}

async function next(cdp) {
  // 2026-10-23 实测：右侧「下一条」箭头无论 JS click 还是真实鼠标都切不动，只有键盘 ArrowDown 生效
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 })
}

async function like(cdp) {
  const r = await cdp.eval(`(() => {
    const el = document.querySelector('[data-e2e="video-player-digg"]')
    if (!el) return null
    const rr = el.getBoundingClientRect()
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: rr.x + rr.width / 2, clientY: rr.y + rr.height / 2 }))
    }
    return true
  })()`)
  await sleep(1200)
  return r
}

function quota() {
  let s = {}
  try { s = JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { }
  if (!s[today()]) s[today()] = { likes: 0, comments: 0 }
  return s
}

const main = async () => {
  const argv = process.argv.slice(2)
  const mode = argv.find((a) => a.startsWith('--')) || '--analyze'
  const autoLike = argv.includes('--like')
  const nIdx = argv.indexOf('--watch')
  const count = nIdx >= 0 ? Number(argv[nIdx + 1]) || 3 : 3

  await ensureBrowser()
  const { cdp } = await connectPage()
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false })
    await sleep(1000)

    if (mode === '--analyze') {
      await play(cdp)
      await sleep(1200)
      console.log(JSON.stringify(await cdp.eval(READ_JS), null, 2))
      return
    }

    const st = quota()
    let liked = 0
    let watched = 0
    // 时间预算：--minutes N 就是「刷 N 分钟」，不写就按 --watch 的条数
    const mi = argv.indexOf('--minutes')
    const budgetMin = mi >= 0 ? Number(argv[mi + 1]) || 0 : 0
    const endAt = budgetMin > 0 ? Date.now() + budgetMin * 60000 : 0
    const clock = () => (endAt ? `剩 ${Math.max(0, Math.round((endAt - Date.now()) / 60000))} 分` : `${count} 条上限`)
    for (let i = 1; ; i++) {
      if (endAt ? Date.now() >= endAt : i > count) break
      await play(cdp)
      await sleep(1500)
      const info = await cdp.eval(READ_JS)
      // 直播卡片没有时长/点赞按钮，直接跳过（不计入观看数）
      if (!info.duration || !info.diggState) {
        console.log(`[${i} · ${clock()}] 跳过直播/无互动元素：${info.author || '?'}`)
        await next(cdp)
        await sleep(2500)
        continue
      }
      const alreadyLiked = /digged/.test(info.diggState) && !/no-digged/.test(info.diggState)
      let stay
      if (info.duration > 0 && info.duration <= 20) stay = (info.duration + jitter(1, 3)) * 1000
      else stay = jitter(12000, 30000)
      console.log(`[${i} · ${clock()}] ${info.author} | ${info.desc.slice(0, 40)} | ${info.duration}s | 停留 ${Math.round(stay / 1000)}s`)
      watched += 1

      let didLike = false
      if (autoLike && !alreadyLiked && st[today()].likes < LIKE_DAILY && Math.random() < 0.45) {
        await sleep(jitter(3000, Math.min(8000, Math.max(4000, stay - 2000))))
        await like(cdp)
        const after = await cdp.eval(READ_JS)
        didLike = /digged/.test(after.diggState) && !/no-digged/.test(after.diggState)
        if (didLike) { st[today()].likes += 1; liked += 1 }
        console.log(`      点赞: ${didLike ? '✅' : '⚠️ 没生效'}`)
        stay = Math.max(1500, stay - jitter(3000, 8000))
      }
      // 预算快用完时别硬撑：停留时间按剩余预算收敛，最少 5 秒
      if (endAt) {
        const left = endAt - Date.now()
        if (left < stay) stay = Math.max(5000, left)
      }
      await sleep(stay)

      fs.appendFileSync(WATCHED, JSON.stringify({
        at: new Date().toISOString(), platform: 'douyin',
        author: info.author, desc: info.desc, duration: info.duration,
        stayMs: stay, liked: didLike,
      }) + '\n')

      const beforeKey = info.author + '|' + info.desc
      await next(cdp)
      let changed = false
      for (let k = 0; k < 20; k++) {
        await sleep(500)
        const cur = await cdp.eval(READ_JS)
        if (cur.author + '|' + cur.desc !== beforeKey) { changed = true; break }
      }
      if (!changed) {
        // 兜底：点视口内那个「下一条」箭头（注意要取在视口里的，不然点到上一条的）
        const ok = await cdp.eval(`(() => {
          const els = [...document.querySelectorAll('[data-e2e="video-switch-next-arrow"]')]
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 4 && r.bottom > 0 && r.top < innerHeight)
          if (!els.length) return false
          const { el, r } = els[0]
          for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }))
          }
          return true
        })()`)
        await sleep(3500)
        const cur2 = await cdp.eval(READ_JS)
        changed = cur2.author + '|' + cur2.desc !== beforeKey
        if (!changed) console.log(`      ⚠️ 下一条没切换成功（箭头点击=${ok}）`)
      }
    }
    fs.writeFileSync(STATE, JSON.stringify(st, null, 2))
    console.log(`完成：看 ${watched} 条（${budgetMin ? budgetMin + ' 分钟预算' : count + ' 条上限'}），点赞 ${liked} 次；今日点赞 ${st[today()].likes}/${LIKE_DAILY}`)
  } finally {
    cdp.close()
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
