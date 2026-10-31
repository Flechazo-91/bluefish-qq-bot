// 抖音发布（视频）：上传 mp4 → 填描述/标题 → 发布。
//   node dy_publish_video.mjs --video <mp4> --title "标题" --desc "文案"           只上传并填好（dry-run）
//   node dy_publish_video.mjs --video <mp4> --title "标题" --desc "文案" --yes     真发
import fs from 'node:fs'
import path from 'node:path'
import { ensureBrowser, openTab, closeTab } from './dy.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const argv = process.argv.slice(2)
const val = (n, d = '') => { const i = argv.indexOf(n); return i >= 0 ? (argv[i + 1] || d) : d }
const video = val('--video')
const title = val('--title')
const desc = val('--desc')
const yes = argv.includes('--yes')
const uploadUrl = 'https://creator.douyin.com/creator-micro/content/upload'

async function setFiles(cdp, selector, files) {
  const r = await cdp.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` })
  const objectId = r.result?.objectId
  if (!objectId) throw new Error('找不到文件输入框: ' + selector)
  await cdp.send('DOM.setFileInputFiles', { files, objectId })
}

async function waitEditor(cdp, ms = 120000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const ok = await cdp.eval(`(() => {
      const hasDesc = [...document.querySelectorAll('[contenteditable="true"], textarea')]
        .some((e) => { const r = e.getBoundingClientRect(); return r.width > 200 && r.height > 40 })
      const hasBtn = [...document.querySelectorAll('button, [role="button"], div, span')]
        .some((e) => (e.innerText || '').trim() === '发布')
      return hasDesc && hasBtn
    })()`)
    if (ok) return true
    await sleep(3000)
  }
  return false
}

const main = async () => {
  if (!video || !fs.existsSync(video)) { console.error('视频不存在:', video); process.exit(1) }
  await ensureBrowser()
  const { cdp, target } = await openTab(uploadUrl)
  try {
    await sleep(8000)
    // 默认就在「发布视频」页签；确保一下
    await cdp.eval(`(() => {
      const els = [...document.querySelectorAll('*')].filter(e => (e.innerText||'').trim() === '发布视频' && e.getBoundingClientRect().width > 20)
      const el = els[els.length - 1]
      if (!el) return false
      const r = el.getBoundingClientRect()
      for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:r.x+r.width/2,clientY:r.y+r.height/2}))
      return true
    })()`)
    await sleep(2500)

    await setFiles(cdp, 'input[type=file][accept*="video"]', [path.resolve(video)])
    console.log('已选择视频，等上传/转码…')
    const ok = await waitEditor(cdp)
    console.log('编辑器就绪:', ok)
    if (!ok) { await cdp.screenshot(`D:\\AstrBot\\douyin\\shots\\vpub-fail-${Date.now()}.png`); return }

    const info = await cdp.eval(`(() => {
      const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
      const inputs = [...document.querySelectorAll('input')].filter(e => e.type !== 'file').map(el => ({ ph: el.placeholder || '', val: (el.value||'').slice(0,20), ...rect(el) }))
      const eds = [...document.querySelectorAll('[contenteditable="true"], textarea')].map(el => ({ tag: el.tagName, ph: el.placeholder || el.getAttribute('data-placeholder') || '', ...rect(el) })).filter(o => o.w > 200)
      return { inputs, eds }
    })()`)
    console.log('表单:', JSON.stringify(info))

    if (title) {
      const r = await cdp.eval(`(() => {
        const inputs = [...document.querySelectorAll('input')].filter(e => e.type !== 'file')
        const el = inputs.find(e => (e.placeholder || '').includes('标题')) || inputs.find(e => e.getBoundingClientRect().width > 100)
        if (!el) return null
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(el, ${JSON.stringify(title)})
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return el.value
      })()`)
      console.log('标题:', JSON.stringify(r))
    }
    if (desc) {
      const r = await cdp.eval(`(() => {
        const el = [...document.querySelectorAll('[contenteditable="true"], textarea')]
          .find(e => { const r = e.getBoundingClientRect(); return r.width > 200 && r.height > 40 })
        if (!el) return null
        el.focus()
        if (el.tagName === 'TEXTAREA') {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
          setter.call(el, ${JSON.stringify(desc)})
          el.dispatchEvent(new Event('input', { bubbles: true }))
        } else {
          document.execCommand('insertText', false, ${JSON.stringify(desc)})
        }
        return (el.value !== undefined ? el.value : el.innerText).slice(0, 40)
      })()`)
      console.log('描述:', JSON.stringify(r))
    }
    await sleep(1500)
    await cdp.screenshot(`D:\\AstrBot\\douyin\\shots\\vpub-filled-${Date.now()}.png`)
    if (!yes) { console.log('（dry-run，没点发布；加 --yes 才发）'); return }

    const clicked = await cdp.eval(`(() => {
      const cands = [...document.querySelectorAll('button, [role="button"], div, span')]
        .filter(e => (e.innerText || '').trim() === '发布')
        .map(e => ({ e, r: e.getBoundingClientRect() }))
        .filter(o => o.r.width > 40 && o.r.height > 20)
        .sort((a, b) => a.r.y - b.r.y)
      if (!cands.length) return null
      const { e, r } = cands[0]
      for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) e.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:r.x+r.width/2,clientY:r.y+r.height/2}))
      return { x: Math.round(r.x), y: Math.round(r.y) }
    })()`)
    console.log('点发布:', JSON.stringify(clicked))
    await sleep(8000)
    console.log('发布后 url:', await cdp.eval('location.href'))
    await cdp.screenshot(`D:\\AstrBot\\douyin\\shots\\vpub-done-${Date.now()}.png`)
  } finally {
    cdp.close()
    await closeTab(target.id)
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
