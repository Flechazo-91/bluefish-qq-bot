// 把调试用的 Edge 窗口拉到屏幕上 / 挪回屏幕外。
// 主人自己想点几下登录时用这个：窗口拉到前台，他手动扫码或输密码，登录态直接落进 profile。
//
//   node dy_window.mjs --show    拉到屏幕内（100,60，1280x900）
//   node dy_window.mjs --hide    挪回屏幕外（默认状态）
import { ensureBrowser, pageTarget } from './dy.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function windowFor(targetId) {
  const r = await fetch(`http://127.0.0.1:9222/json/version`).then((x) => x.json())
  const ws = new WebSocket(r.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('ws error')), { once: true })
    setTimeout(() => rej(new Error('ws 超时')), 8000)
  })
  let id = 0
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const myId = ++id
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id === myId) {
        ws.removeEventListener('message', onMsg)
        m.error ? reject(new Error(m.error.message)) : resolve(m.result)
      }
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id: myId, method, params }))
    setTimeout(() => reject(new Error('CDP 超时 ' + method)), 15000)
  })
  try {
    const t = await pageTarget()
    const { windowId } = await call('Browser.getWindowForTarget', { targetId: targetId || t.id })
    return { call, windowId, close: () => ws.close() }
  } catch (e) {
    ws.close()
    throw e
  }
}

const main = async () => {
  const show = process.argv.includes('--show')
  await ensureBrowser({ url: 'https://www.douyin.com/' })
  const t = await pageTarget()
  const { call, windowId, close } = await windowFor(t.id)
  try {
    if (show) {
      await call('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'normal', left: 80, top: 60, width: 1280, height: 900 },
      })
      console.log('窗口已拉到屏幕（80,60 1280x900）')
    } else {
      await call('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'normal', left: -32000, top: -32000, width: 1280, height: 900 },
      })
      console.log('窗口已挪回屏幕外')
    }
    await sleep(500)
  } finally {
    close()
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
