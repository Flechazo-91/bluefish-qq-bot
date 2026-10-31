// 抖音发布（图文）：上传图片 → 填标题/正文 → 发布。
//   node dy_publish.mjs --images a.jpg,b.jpg --title "标题" --desc "正文" --inspect   只上传并 dump 表单结构
//   node dy_publish.mjs --images ... --title ... --desc ...                           填完不发布（dry-run）
//   node dy_publish.mjs --images ... --title ... --desc ... --yes                     真发布
import fs from 'node:fs'
import path from 'node:path'
import { ensureBrowser, openTab, closeTab } from './dy.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const argv = process.argv.slice(2)
const val = (name, def = '') => { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] || def) : def }
const images = val('--images').split(',').map((s) => s.trim()).filter(Boolean)
const title = val('--title')
const desc = val('--desc')
const inspect = argv.includes('--inspect')
const yes = argv.includes('--yes')
const uploadUrl = 'https://creator.douyin.com/creator-micro/content/upload'

async function setFiles(cdp, selector, files) {
  const r = await cdp.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` })
  const objectId = r.result?.objectId
  if (!objectId) throw new Error('找不到文件输入框: ' + selector)
  await cdp.send('DOM.setFileInputFiles', { files, objectId })
}

async function dumpForm(cdp) {
  return await cdp.eval(`(() => {
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
    const inputs = [...document.querySelectorAll('input')].filter(e => e.type !== 'file').map(el => ({ type: el.type, ph: el.placeholder || '', val: (el.value || '').slice(0, 30), ...rect(el) }))
    const editables = [...document.querySelectorAll('textarea, [contenteditable="true"]')].map(el => ({ tag: el.tagName, ph: el.placeholder || el.getAttribute('data-placeholder') || '', ...rect(el) }))
    const btns = [...document.querySelectorAll('button, [role="button"], span, div')].map(el => ({ el, t: (el.innerText || '').trim() })).filter(o => /^(发布|存草稿|保存草稿)$/.test(o.t)).map(o => ({ text: o.t, ...rect(o.el) })).filter(o => o.w > 20 && o.h > 10)
    const thumbs = [...document.querySelectorAll('img')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 60 && r.height > 60 }).length
    return { url: location.href, inputs, editables, btns: btns.slice(0, 10), thumbCount: thumbs }
  })()`)
}

const main = async () => {
  if (!images.length) { console.error('要给 --images'); process.exit(1) }
  for (const f of images) if (!fs.existsSync(f)) { console.error('图片不存在:', f); process.exit(1) }

  await ensureBrowser()
  const { cdp, target } = await openTab(uploadUrl)
  try {
    await sleep(8000)
    // 1) 切到「发布图文」
    await cdp.eval(`(() => {
      const els = [...document.querySelectorAll('*')].filter(e => (e.innerText || '').trim() === '发布图文' && e.getBoundingClientRect().width > 20)
      const el = els[els.length - 1]
      if (!el) return false
      const r = el.getBoundingClientRect()
      for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:r.x+r.width/2,clientY:r.y+r.height/2}))
      return true
    })()`)
    await sleep(3000)

    // 2) 上传图片
    await setFiles(cdp, 'input[type=file][accept*="image"]', images.map((f) => path.resolve(f)))
    console.log('已设置文件:', images.join(', '))
    await sleep(12000)

    const form = await dumpForm(cdp)
    console.log('表单:', JSON.stringify(form, null, 2))
    await cdp.screenshot(`D:\\AstrBot\\douyin\\shots\\publish-${Date.now()}.png`)
    if (inspect) return

    // 3) 填标题（通常是第一个非文件 input）与正文（contenteditable）
    if (title) {
      const ok = await cdp.eval(`(() => {
        // 优先按「添加作品标题」的 placeholder 找标题框（图文页标题是选填的 20 字）
        const inputs = [...document.querySelectorAll('input')].filter(e => e.type !== 'file')
        const el = inputs.find(e => (e.placeholder || '').includes('标题')) || inputs.find(e => e.getBoundingClientRect().width > 100)
        if (!el) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(el, ${JSON.stringify(title)})
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return el.value
      })()`)
      console.log('标题写入:', JSON.stringify(ok))
    }
    if (desc) {
      const ok = await cdp.eval(`(() => {
        const el = [...document.querySelectorAll('[contenteditable="true"], textarea')].find(e => { const r = e.getBoundingClientRect(); return r.width > 200 && r.height > 40 })
        if (!el) return false
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
      console.log('正文写入:', JSON.stringify(ok))
    }
    await sleep(1500)
    await cdp.screenshot(`D:\\AstrBot\\douyin\\shots\\publish-filled-${Date.now()}.png`)

    if (!yes) { console.log('（dry-run，没有点发布；加 --yes 才发）'); return }

    // 4) 点发布
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
    await sleep(6000)
    console.log('发布后 url:', await cdp.eval('location.href'))
    await cdp.screenshot(`D:\\AstrBot\\douyin\\shots\\published-${Date.now()}.png`)
  } finally {
    cdp.close()
    await closeTab(target.id)
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
