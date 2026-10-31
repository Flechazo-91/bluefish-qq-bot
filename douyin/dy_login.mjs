// 抖音登录：把弹窗里的二维码截图发到主人 QQ，等他扫完，再确认登录态。
//   node dy_login.mjs            出码 + 发给主人 + 轮询（默认 5 分钟）
//   node dy_login.mjs --no-send  只出码（不发送，调试用）
//   node dy_login.mjs --check    只检查是不是已经登录
import fs from 'node:fs'
import path from 'node:path'
import { ensureBrowser, connectPage, HOME, DEBUG_PORT } from './dy.mjs'

const TOKEN = 'YOUR_ONEBOT_TOKEN'
const OWNER = 1000002
const ONEBOX = 'http://127.0.0.1:3000/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function onebot(action, params) {
  const r = await fetch(ONEBOX, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ action, params }),
  })
  return r.json()
}

async function sendImage(file) {
  const b64 = fs.readFileSync(file).toString('base64')
  const r = await onebot('send_private_msg', {
    user_id: OWNER,
    message: [
      { type: 'text', data: { text: '抖音要扫个码，扫完我这边会自动继续（5 分钟内有效）。' } },
      { type: 'image', data: { file: 'base64://' + b64 } },
    ],
  })
  return r
}

async function sendText(text) {
  return onebot('send_private_msg', { user_id: OWNER, message: [{ type: 'text', data: { text } }] })
}

async function loginState(cdp) {
  const cookies = await cdp.send('Network.getCookies', { urls: ['https://www.douyin.com'] })
  const names = new Set((cookies?.cookies || []).map((c) => c.name))
  const hasSession = names.has('sessionid') || names.has('sessionid_ss') || names.has('sid_tt')
  const modal = await cdp.eval(`(() => {
    const t = document.body ? document.body.innerText : ''
    const hasScanText = /扫码登录|验证码登录|密码登录/.test(t)
    const hasPanel = !!document.querySelector('[data-e2e*="login"], [id*="login"], [class*="login-container"], [class*="login-panel"]')
    const qr = [...document.querySelectorAll('img, canvas')].some((el) => {
      const r = el.getBoundingClientRect()
      return r.width >= 110 && r.width <= 340 && Math.abs(r.width - r.height) <= 8 && r.x > 150
    })
    return hasScanText || hasPanel || qr
  })()`)
  return { hasSession, hasModal: modal, cookieNames: [...names].slice(0, 8) }
}

/** 找二维码那张图：方形、110~340、不在最左边（侧栏 logo 会被排除） */
async function qrRect(cdp) {
  return await cdp.eval(`(() => {
    const cands = [...document.querySelectorAll('img, canvas')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width >= 110 && r.width <= 340 && Math.abs(r.width - r.height) <= 8
                         && r.x > 150 && r.y > 40)
      .sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height))
    if (!cands.length) return null
    const { r } = cands[0]
    const pad = 10
    return {
      x: Math.round(r.x - pad), y: Math.round(r.y - pad),
      width: Math.round(r.width + pad * 2), height: Math.round(r.height + pad * 2),
    }
  })()`)
}

async function qrExpired(cdp) {
  try {
    return await cdp.eval(`/二维码失效|点击刷新|二维码已失效/.test(document.body.innerText)`)
  } catch { return false }
}

/** 二维码过期后点一下刷新（点码区域中心），不行就整页重载 */
async function refreshQr(cdp, rect) {
  const cx = Math.round(rect.x + rect.width / 2)
  const cy = Math.round(rect.y + rect.height / 2)
  try {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 })
    await sleep(1500)
    if (await qrExpired(cdp)) {
      console.log('[刷新] 点击没生效，整页重载')
      await cdp.send('Page.navigate', { url: 'https://www.douyin.com/' })
      await sleep(6000)
    }
  } catch (e) {
    console.log('[刷新] 失败:', e.message)
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const checkOnly = argv.includes('--check')
  const noSend = argv.includes('--no-send')
  const sendIdx = argv.indexOf('--send')

  if (sendIdx >= 0) {
    const file = argv[sendIdx + 1]
    const r = await sendImage(file)
    console.log('已发送:', JSON.stringify(r).slice(0, 160))
    return
  }

  await ensureBrowser({ url: 'https://www.douyin.com/' })
  const { cdp } = await connectPage()
  await cdp.send('Network.enable').catch(() => { })
  try {
    if (!checkOnly) {
      await cdp.send('Page.navigate', { url: 'https://www.douyin.com/' })
      await sleep(5000)
    }
    const st = await loginState(cdp)
    console.log('登录态:', JSON.stringify(st))
    if (st.hasSession && !st.hasModal) {
      console.log('[OK] 已经登录，不用扫码')
      return
    }
    if (checkOnly) return

    // 等二维码渲染出来（弹窗是异步挂的）
    let rect = null
    for (let i = 0; i < 20; i++) {
      rect = await qrRect(cdp)
      if (rect) break
      await sleep(1000)
    }
    console.log('二维码区域:', JSON.stringify(rect))
    if (!rect) throw new Error('没找到二维码元素，截图整页人工看')

    const shot = path.join(HOME, 'shots', 'login-qr.png')
    fs.mkdirSync(path.dirname(shot), { recursive: true })

    const captureAndSend = async (label) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await qrExpired(cdp)) await refreshQr(cdp, rect)
        const nr = await qrRect(cdp)
        if (nr) rect = nr
        await sleep(900)
        if (await qrExpired(cdp)) continue
        const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 3 } })
        fs.writeFileSync(shot, Buffer.from(r.data, 'base64'))
        console.log(`[${label}] 二维码截图 ${fs.statSync(shot).size} bytes`)
        if (!noSend) {
          const rr = await sendImage(shot)
          console.log(`[${label}] 已发到主人 QQ:`, JSON.stringify(rr).slice(0, 100))
        }
        return true
      }
      console.log(`[${label}] 三次都没拿到有效二维码`)
      return false
    }

    await captureAndSend('首次')
    let lastSent = Date.now()
    let sends = 1
    const MAX_SENDS = 4
    // 只截不发（界面里给主人看）时刷新勤一点：二维码本身 ~60 秒就失效
    const interval = noSend ? 50 * 1000 : 90 * 1000

    const minutesIdx = argv.indexOf('--minutes')
    const minutes = minutesIdx >= 0 ? Number(argv[minutesIdx + 1]) || 15 : 15
    const deadline = Date.now() + minutes * 60 * 1000
    while (Date.now() < deadline) {
      await sleep(3000)
      const s = await loginState(cdp)
      if (s.hasSession) {
        console.log('\n[OK] 已登录（拿到 sessionid）')
        await sleep(2500)
        const after = await cdp.eval(`({ url: location.href })`)
        console.log('页面:', JSON.stringify(after))
        try {
          fs.writeFileSync(path.join(HOME, 'login-ok.json'), JSON.stringify({
            at: new Date().toISOString(), url: after?.url || '',
          }, null, 2))
          const r = await sendText('抖音登录成功啦，我这边可以开始刷了。')
          console.log('已通知主人:', JSON.stringify(r).slice(0, 100))
        } catch (e) { console.log('通知失败:', e.message) }
        return
      }
      if (Date.now() - lastSent > interval && (noSend || sends < MAX_SENDS)) {
        const nr = await qrRect(cdp)
        if (nr) rect = nr
        await captureAndSend(sends + 1 + '')
        lastSent = Date.now()
        sends += 1
      }
      process.stdout.write('.')
    }
    console.log('\n[TIMEOUT] 15 分钟内没扫码')
  } finally {
    cdp.close()
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
