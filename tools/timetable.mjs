// 课表提醒：早报 + 课前 15 分钟
//
// 用法:
//   node timetable.mjs --morning      # 今日课表早报（07:30 的计划任务用）
//   node timetable.mjs --check        # 课前 15 分钟提醒（每 10 分钟跑一次）
//   node timetable.mjs --next         # 只打印下一节课（调试用）
//   node timetable.mjs --tomorrow     # 明日课表（预览/手动补发用）
//   node timetable.mjs --kb           # 把课表写进知识库（kb/timetable.md）
//   node timetable.mjs --dry          # 不发消息，只打印
//   node timetable.mjs --to 123456    # 只发给这一个人（覆盖收件人列表）
//
// 收件人：timetable.json 里的 "recipients": [1000002, 1000003]
//   2026-10-22：示例好友（1000003）的课表跟主人一样，所以他也收同一份早报/课前提醒。
//
// 数据：D:/AstrBot/timetable.json（我按你的课表截图填；调课就覆盖这个文件）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const DIR = 'D:\\AstrBot'
const CFG = path.join(DIR, 'timetable.json')
const STATE = path.join(DIR, 'timetable-state.json')
const TOKEN = 'YOUR_ONEBOT_TOKEN'
const OWNER = 1000002
const ASTR = 'http://127.0.0.1:6185/api/kb'
const JWT_SECRET = 'YOUR_KB_JWT_SECRET'
const KB_ID = '6264ca3b-1542-492a-b510-3f89418cdcb6'
const LEAD_MIN = 15          // 课前多少分钟提醒
const DRY = process.argv.includes('--dry')

const argv = process.argv.slice(2)
const mode = argv.find((a) => a.startsWith('--'))?.slice(2) ?? 'next'
const toIdx = argv.indexOf('--to')
const toOne = toIdx >= 0 ? Number(argv[toIdx + 1]) || 0 : 0
const noteIdx = argv.indexOf('--note')
const note = noteIdx >= 0 ? String(argv[noteIdx + 1] ?? '') : ''

const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }
const save = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n')

const cfg = load(CFG, { courses: [] })

const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
const weekday = ((now.getDay() + 6) % 7) + 1     // 1=周一 … 7=周日
const minutesOf = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m }
const nowMin = now.getHours() * 60 + now.getMinutes()

// 课表可以按周下发（学校课表每周都可能不同）：weeks[] 里选包含今天的那个；
// 没命中就退回扁平的 courses[]（兼容老格式），并标记成"本周没录"。
const weeks = Array.isArray(cfg.weeks) ? cfg.weeks : []
const curWeek = weeks.find((w) => w.from && w.to && w.from <= today && today <= w.to)
const courses = Array.isArray(curWeek?.courses) ? curWeek.courses : (Array.isArray(cfg.courses) ? cfg.courses : [])
const weekLabel = curWeek?.label ?? ''
const coverageMiss = weeks.length > 0 && !curWeek

function todays() {
  return courses
    .filter((c) => Number(c.weekday) === weekday)
    .filter((c) => !c.weeks || /全部|每/.test(c.weeks) || true)   // 单双周暂不细判，先全给
    .sort((a, b) => minutesOf(a.start) - minutesOf(b.start))
}

async function onebot(action, params = {}) {
  const r = await fetch('http://127.0.0.1:3000/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ action, params }),
  })
  return r.json()
}
const cfgRecipients = Array.isArray(cfg.recipients) && cfg.recipients.length
  ? cfg.recipients.map(Number).filter((n) => Number.isFinite(n))
  : [OWNER]
const recipients = toOne ? [toOne] : cfgRecipients
async function push(text) {
  const body = note ? text + '\n\n' + note : text
  if (DRY) { console.log('[dry] 收件人 ' + recipients.join(',') + ' 不发：\n' + body); return }
  for (const uid of recipients) {
    try {
      const r = await onebot('send_private_msg', { user_id: uid, message: [{ type: 'text', data: { text: body } }] })
      console.log((r?.retcode === 0 ? '已发送 -> ' : '发送失败 -> ') + uid + ' ' + JSON.stringify(r).slice(0, 100))
    } catch (e) {
      console.log('发送异常 -> ' + uid + ' ' + e.message)
    }
  }
}

function fmt(c) {
  return `${c.start}–${c.end} ${c.name}${c.room ? ' @ ' + c.room : ''}${c.teacher ? '（' + c.teacher + '）' : ''}`
}

if (mode === 'morning') {
  if (coverageMiss) {
    await push(`【课表】${today} 这一周的课表我还没有（现有：${weeks.map((w) => w.label).join('、')}）。\n发我一张本周截图就行，我更新后自动接着提醒。`)
    process.exit(0)
  }
  const list = todays()
  if (!list.length) { console.log('今天没课'); process.exit(0) }
  const body = [
    `【今日课表 · ${today}${weekLabel ? '（' + weekLabel + '）' : ''}】`,
    ...list.map((c, i) => `${i + 1}. ${fmt(c)}`),
    list[0].start ? `第一节 ${list[0].start} 开始，别迟到。` : '',
  ].filter(Boolean).join('\n')
  await push(body)
  process.exit(0)
}

if (mode === 'check') {
  const st = load(STATE, { announced: {} })
  const list = todays()
  for (const uid of recipients) {
    for (const c of list) {
      const key = `${uid}|${today}|${c.start}|${c.name}`
      if (st.announced[key]) continue
      const left = minutesOf(c.start) - nowMin
      if (left <= LEAD_MIN && left >= 0) {
        const text = `【还有 ${left} 分钟】${fmt(c)}\n该走了，别卡点。`
        if (DRY) {
          console.log('[dry] -> ' + uid + '\n' + text)
        } else {
          const r = await onebot('send_private_msg', { user_id: uid, message: [{ type: 'text', data: { text } }] })
          if (r?.retcode !== 0) { console.log('发送失败 -> ' + uid + ' ' + JSON.stringify(r).slice(0, 100)); continue }
          console.log('已发送 -> ' + uid)
        }
        st.announced[key] = new Date().toISOString()
        save(STATE, st)
      }
    }
  }
  process.exit(0)
}

// 明日课表（手动补发 / 预览用）
if (mode === 'tomorrow') {
  const d = new Date(now)
  d.setDate(d.getDate() + 1)
  const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const wd = ((d.getDay() + 6) % 7) + 1
  const w = weeks.find((x) => x.from && x.to && x.from <= iso && iso <= x.to)
  const pool = Array.isArray(w?.courses) ? w.courses : courses
  const list = pool.filter((c) => Number(c.weekday) === wd).sort((a, b) => minutesOf(a.start) - minutesOf(b.start))
  const names = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']
  if (!list.length) { console.log('明天没课'); process.exit(0) }
  await push([
    `【明日课表 · ${iso}（${names[wd]}${w?.label ? '，' + w.label : ''}）】`,
    ...list.map((c, i) => `${i + 1}. ${fmt(c)}`),
    `第一节 ${list[0].start} 开始，别迟到。`,
  ].join('\n'))
  process.exit(0)
}

// 下周课表有没有录？没有就提醒主人发截图（每周日 20:00 的计划任务用）
if (mode === 'need-week') {
  const d = new Date(now)
  const addDays = ((8 - weekday) % 7) || 7          // 到下周一还差几天
  d.setDate(d.getDate() + addDays)
  const nextMon = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const covered = weeks.some((w) => w.from <= nextMon && nextMon <= w.to)
  if (covered) { console.log(`下周（${nextMon} 起）已有课表，不提醒`); process.exit(0) }
  // 催课表只发给"维护课表的人"（默认主人）。示例好友只是跟着收提醒，不用他来交数据；
  // 想让他也收到，就在 timetable.json 里加 "needWeekRecipients": [1000002, 1000003]
  const askList = Array.isArray(cfg.needWeekRecipients) && cfg.needWeekRecipients.length
    ? cfg.needWeekRecipients.map(Number).filter((n) => Number.isFinite(n))
    : [OWNER]
  recipients.length = 0
  recipients.push(...askList)
  await push(`【课表】下周（${nextMon} 起）的我还没有。\n把课表 App 里下周那页截图发我就行，我更新后自动生效。`)
  process.exit(0)
}

if (mode === 'kb') {
  const names = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']
  // 2026-10-22：原来只写"当前那一周"，主人要本周+下两周 → 现在所有已录入周次都写进知识库
  const weekList = weeks.length
    ? weeks
    : [{ label: '', from: '', to: '', courses }]
  const md = [
    `# 我的课表${cfg.term ? '（' + cfg.term + '）' : ''}`, '',
    `更新：${cfg.updated ?? today}` +
      (weekList.length > 1 ? `｜已录入：${weekList.map((w) => w.label || '未命名周').join('、')}` : ''), '',
  ]
  for (const w of weekList) {
    md.push(`## ${w.label || '本周'}${w.from ? `（${w.from} ~ ${w.to}）` : ''}`)
    md.push('')
    const byDay = {}
    for (const c of w.courses ?? []) (byDay[c.weekday] ??= []).push(c)
    for (let d = 1; d <= 7; d++) {
      const list = (byDay[d] ?? []).sort((a, b) => minutesOf(a.start) - minutesOf(b.start))
      if (!list.length) continue
      md.push(`### ${names[d]}`)
      for (const c of list) md.push(`- ${c.start}–${c.end} ${c.name}${c.room ? ' @ ' + c.room : ''}${c.teacher ? '（' + c.teacher + '）' : ''}`)
      md.push('')
    }
  }
  const text = md.join('\n')
  fs.writeFileSync(path.join(DIR, 'kb', 'timetable.md'), text, 'utf8')
  console.log('kb/timetable.md 已更新，' + weekList.length + ' 个周次，' + text.length + ' 字')

  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const h = b64({ alg: 'HS256', typ: 'JWT' })
  const n = Math.floor(Date.now() / 1000)
  const p = b64({ username: 'astrbot', exp: n + 600, iat: n })
  const H = { Authorization: `Bearer ${h}.${p}.${crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url')}`, 'Content-Type': 'application/json' }
  const docs = await (await fetch(`${ASTR}/document/list?kb_id=${KB_ID}&page=1&page_size=200`, { headers: H })).json()
  for (const d of docs?.data?.items ?? []) {
    if ((d.doc_name ?? d.file_name) === 'timetable.md') {
      await fetch(`${ASTR}/document/delete`, { method: 'POST', headers: H, body: JSON.stringify({ kb_id: KB_ID, doc_id: d.doc_id }) })
    }
  }
  const chunks = text.split(/\n(?=## )/).map((s) => s.trim()).filter(Boolean)
  const imp = await (await fetch(`${ASTR}/document/import`, { method: 'POST', headers: H, body: JSON.stringify({ kb_id: KB_ID, documents: [{ file_name: 'timetable.md', chunks }] }) })).json()
  console.log('已写入知识库:', JSON.stringify(imp?.data ?? imp).slice(0, 120))
  process.exit(0)
}

// next
const list = todays().filter((c) => minutesOf(c.end) >= nowMin)
console.log(list.length ? fmt(list[0]) : '今天没有后续课程')
