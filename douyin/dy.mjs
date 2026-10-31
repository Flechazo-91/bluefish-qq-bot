// 抖音自动化的底层：用本机 Edge + CDP 驱动一个独立 profile 的浏览器。
// 不依赖 playwright/puppeteer —— Node 24 自带 WebSocket，直接说 CDP 协议。
//
// 用法（都是命令行子命令）:
//   node dy.mjs launch          启动/复用带调试端口的 Edge（独立 profile，窗口挪到屏幕外）
//   node dy.mjs kill            关掉这套调试 Edge
//   node dy.mjs goto <url>      打开页面
//   node dy.mjs eval "<js>"     在页面里执行 JS 并打印结果
//   node dy.mjs shot [path]     截图
//   node dy.mjs info            打印当前页面 URL/标题/登录状态
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const HOME = 'D:\\AstrBot\\douyin'
export const PROFILE = path.join(HOME, 'profile')
export const DEBUG_PORT = 9222
export const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function httpJson(url, timeout = 3000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeout)
  try {
    const r = await fetch(url, { signal: ac.signal })
    return await r.json()
  } finally {
    clearTimeout(t)
  }
}

export async function browserAlive() {
  try {
    const v = await httpJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
    return Boolean(v?.webSocketDebuggerUrl)
  } catch {
    return false
  }
}

export async function ensureBrowser({ url = 'https://www.douyin.com/' } = {}) {
  if (!(await browserAlive())) {
    fs.mkdirSync(PROFILE, { recursive: true })
    const args = [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=Translate,msEdgeSidebarV2',
      '--window-position=-32000,-32000',
      '--window-size=1280,900',
      '--autoplay-policy=no-user-gesture-required',
      url,
    ]
    const p = spawn(EDGE, args, { detached: true, stdio: 'ignore' })
    p.unref()
    for (let i = 0; i < 40; i++) {
      await sleep(500)
      if (await browserAlive()) break
    }
    if (!(await browserAlive())) throw new Error('Edge 调试端口没起来')
  }
  return true
}

/** 拿一个 page 目标的 ws 地址（优先 douyin 页面，其次第一个 page） */
export async function pageTarget() {
  const list = await httpJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
  const pages = (list || []).filter((t) => t.type === 'page')
  const dy = pages.find((t) => /douyin\.com/.test(t.url))
  const t = dy || pages[0]
  if (!t) throw new Error('没有可用的 page 目标')
  return t
}

export class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.events = []
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      } else if (msg.method) {
        this.events.push(msg)
        if (this.events.length > 200) this.events.shift()
      }
    })
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', (e) => reject(new Error('ws error')), { once: true })
      setTimeout(() => reject(new Error('ws 连接超时')), 8000)
    })
    return new CDP(ws)
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时: ${method}`))
        }
      }, 30000)
    })
  }

  async eval(expression, { awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval 异常')
    return r.result?.value
  }

  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
    return file
  }

  close() { try { this.ws.close() } catch { } }
}

export async function connectPage() {
  const t = await pageTarget()
  const c = await CDP.connect(t.webSocketDebuggerUrl)
  await c.send('Page.enable').catch(() => { })
  await c.send('Runtime.enable').catch(() => { })
  return { cdp: c, target: t }
}

/** 开一个新标签页并连上（不动现有页面，比如登录中那个） */
export async function openTab(url) {
  // Edge 较新版本里 /json/new 不带 url 参数，统一连上后再 navigate
  const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new`, { method: 'PUT' })
  const t = await r.json()
  const c = await CDP.connect(t.webSocketDebuggerUrl)
  await c.send('Page.enable').catch(() => { })
  await c.send('Runtime.enable').catch(() => { })
  await c.send('Network.enable').catch(() => { })
  if (url) {
    await c.send('Page.navigate', { url })
    await new Promise((res) => setTimeout(res, 2500))
  }
  return { cdp: c, target: t }
}

export async function closeTab(targetId) {
  try {
    await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${targetId}`)
  } catch { }
}

export async function listTabs() {
  const list = await httpJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
  return (list || []).filter((t) => t.type === 'page').map((t) => ({ id: t.id, url: t.url, title: t.title }))
}

// ── CLI ──────────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('dy.mjs')) {
  const cmd = process.argv[2] || 'info'
  const arg = process.argv[3]

  const main = async () => {
    if (cmd === 'launch') {
      await ensureBrowser({ url: arg || 'https://www.douyin.com/' })
      console.log('浏览器就绪，调试端口', DEBUG_PORT)
      return
    }
    if (cmd === 'kill') {
      try { execFileSync('taskkill', ['/F', '/IM', 'msedge.exe', '/FI', `WINDOWTITLE eq *`], { stdio: 'ignore' }) } catch { }
      // 只杀我们这套 profile 的进程
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -match 'douyin\\\\profile' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`],
        { encoding: 'utf8' })
      console.log('已关闭调试用 Edge')
      return
    }
    if (!(await browserAlive())) { console.error('浏览器没起来，先 node dy.mjs launch'); process.exit(1) }
    const { cdp } = await connectPage()
    try {
      if (cmd === 'goto') {
        await cdp.send('Page.navigate', { url: arg })
        await sleep(3000)
        console.log('已打开', arg)
      } else if (cmd === 'eval') {
        console.log(JSON.stringify(await cdp.eval(arg), null, 2))
      } else if (cmd === 'shot') {
        const f = arg || path.join(HOME, 'shot.png')
        console.log(await cdp.screenshot(f))
      } else if (cmd === 'info') {
        const info = await cdp.eval(`(() => ({
          url: location.href,
          title: document.title,
          readyState: document.readyState,
          hasLoginBtn: !!document.querySelector('[data-e2e="login-button"], [data-e2e="login-panel"]'),
          hasAvatar: !!document.querySelector('[data-e2e="live-avatar"], img[class*="avatar"]'),
          videoCount: document.querySelectorAll('video').length,
        }))()`)
        console.log(JSON.stringify(info, null, 2))
      }
    } finally {
      cdp.close()
    }
  }
  main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
}
