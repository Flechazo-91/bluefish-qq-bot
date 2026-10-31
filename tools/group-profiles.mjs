// 群成员/活跃好友信息库：群名单 + 日志统计 + 已知画像 → 生成 markdown 并写进知识库。
//   node group-profiles.mjs           生成 + 上传知识库
//   node group-profiles.mjs --dry     只生成到 D:/AstrBot/kb\，不上传
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const DIR = 'D:\\AstrBot'
const KB_DIR = path.join(DIR, 'kb')
const LOG_DIR = 'D:\\SnowLuma\\app\\logs'
const TOKEN = 'YOUR_ONEBOT_TOKEN'
const ASTR = 'http://127.0.0.1:6185/api/kb'
const JWT_SECRET = 'YOUR_KB_JWT_SECRET'
const KB_ID = '6264ca3b-1542-492a-b510-3f89418cdcb6'
const GROUPS = [
  { id: 2000001, name: '示例群A' },
  { id: 2000002, name: '示例群B' },
  { id: 2000003, name: '测试001' },
]
const DRY = process.argv.includes('--dry')
const BOT = 1000001

async function onebot(action, params) {
  const r = await fetch('http://127.0.0.1:3000/', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ action, params }),
  })
  return (await r.json())?.data
}

// ---- 1) 日志统计 ----
function parseLogs() {
  const stats = new Map()   // `${gid}|${qq}` -> { count, samples[], hours[], last, name }
  const files = fs.readdirSync(LOG_DIR).filter((f) => /^snowluma-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort()
  const re = /\[Event\]\s*(?:\[自身\]\s*)?群 \[(.+?)\((\d+)\)\] \| \[(.+?)\((\d+)\)\]: ID:-?\d+ (.*)$/
  for (const f of files) {
    const date = f.match(/(\d{4}-\d{2}-\d{2})/)[1]
    for (const line of fs.readFileSync(path.join(LOG_DIR, f), 'utf8').split('\n')) {
      const m = line.match(re)
      if (!m) continue
      const [, gname, gid, nickname, qq, text] = m
      if (Number(qq) === BOT) continue
      const key = `${gid}|${qq}`
      if (!stats.has(key)) stats.set(key, { gid: Number(gid), qq: Number(qq), name: nickname, count: 0, samples: [], hours: {}, last: '', dates: new Set() })
      const s = stats.get(key)
      s.count += 1
      s.name = nickname
      s.dates.add(date)
      const hm = line.match(/^(\d{2}):(\d{2}):\d{2}/)
      if (hm) {
        s.hours[hm[1]] = (s.hours[hm[1]] || 0) + 1
        s.last = `${date} ${hm[1]}:${hm[2]}`
      }
      let clean = (text || '').trim()
      clean = clean.replace(/^\[回复[\s\S]*?\]:\s*/, ' ')   // 去引用前缀（可能嵌套括号）
      clean = clean.replace(/\[(图片|表情|语音|视频|空消息)\]/g, ' ')  // 去组件占位
      clean = clean.replace(/\[回复[^\]]*\]/g, ' ')
      clean = clean.replace(/@\d+/g, '@某人')
      clean = clean.replace(/^[\]\)>:：\s]+/, '').replace(/\s+/g, ' ').trim()
      if (clean && s.samples.length < 4 && clean.length >= 2) {
        s.samples.push(clean.slice(0, 60))
      }
    }
  }
  return stats
}

// ---- 2) 已知画像（kb/friend-*.md） ----
function knownProfiles() {
  const out = new Map()
  for (const f of fs.readdirSync(KB_DIR).filter((x) => /^friend-\d+\.md$/.test(x))) {
    const qq = Number(f.match(/(\d+)/)[1])
    const txt = fs.readFileSync(path.join(KB_DIR, f), 'utf8')
    out.set(qq, txt.trim())
  }
  return out
}

const topHours = (hours) => Object.entries(hours).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([h]) => `${h}时`).join('/') || '—'

let KNOWN = new Map()
const brief = (qq) => {
  const kn = KNOWN.get(Number(qq))
  if (!kn) return ''
  const facts = []
  for (const line of kn.split('\n')) {
    const m = line.match(/^-\s*(性别|年龄|个性签名)[:：]\s*(.+)$/)
    if (m) facts.push(`${m[1]} ${m[2].trim()}`)
  }
  return facts.join('，')
}
const main = async () => {
  const stats = parseLogs()
  const known = knownProfiles()
  KNOWN = known
  const lists = {}
  for (const g of GROUPS) {
    try { lists[g.id] = await onebot('get_group_member_list', { group_id: g.id }) || [] } catch { lists[g.id] = [] }
  }

  // ---------- A) 新群成员名单 ----------
  const g0 = GROUPS[0]
  const members = (lists[g0.id] || []).slice().sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : 0))
  let md = `# ${g0.name}（群号 ${g0.id}）成员信息库\n\n`
  md += `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}　成员 ${members.length} 人\n\n`
  md += `## 成员名单\n\n| QQ | 昵称 | 群名片 | 身份 | 群内发言 | 最近发言 | 已知画像 |\n|---|---|---|---|---|---|---|\n`
  for (const m of members) {
    const st = stats.get(`${g0.id}|${m.user_id}`)
    const role = m.role === 'owner' ? '群主' : m.role === 'admin' ? '管理员' : '成员'
    const kn = known.get(Number(m.user_id))
    const knBrief = kn ? (brief(Number(m.user_id)) || '有档案') : '—'
    md += `| ${m.user_id} | ${m.nickname || ''} | ${m.card || ''} | ${role} | ${st ? st.count : 0} | ${st ? st.last : '—'} | ${knBrief} |\n`
  }
  md += `\n## 说明\n\n- 这个群是 2026-10-29 新加的，群内还没有聊天记录可统计，「群内发言」为 0。\n`
  md += `- 「已知画像」来自已有知识库（在其他群/私聊里积累的印象），点进去看 \`friend-<QQ>.md\`。\n`
  md += `- 群主：${members.find((m) => m.role === 'owner')?.nickname || '?'}；管理员 ${members.filter((m) => m.role === 'admin').length} 人。\n`
  fs.writeFileSync(path.join(KB_DIR, `group-${g0.id}-members.md`), md, 'utf8')
  console.log('写出 group-%d-members.md（%d 人）', g0.id, members.length)

  // ---------- B) 活跃好友总览 ----------
  const tier = (n) => (n >= 20 ? '核心活跃' : n >= 6 ? '常聊' : n >= 2 ? '偶尔冒泡' : '刚出现')

  const merged = new Map()
  for (const s of stats.values()) {
    const cur = merged.get(s.qq) || { qq: s.qq, name: s.name, count: 0, hours: {}, last: '', samples: [], groups: new Set() }
    cur.count += s.count
    if (s.last > cur.last) cur.last = s.last
    cur.name = s.name || cur.name
    cur.groups.add(GROUPS.find((g) => g.id === s.gid)?.name || String(s.gid))
    for (const [h, n] of Object.entries(s.hours)) cur.hours[h] = (cur.hours[h] || 0) + n
    for (const x of s.samples) if (cur.samples.length < 4) cur.samples.push(x)
    merged.set(s.qq, cur)
  }
  const active = [...merged.values()].sort((a, b) => b.count - a.count)
  const gnameOf = (s) => [...s.groups].join('/')

  let md2 = `# 活跃好友信息库（跨群统计）\n\n`
  md2 += `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}　数据来源：SnowLuma 日志最近 7 天\n`
  md2 += `共统计到 ${active.length} 人在群里说过话，按发言量排序。\n\n`
  md2 += `| # | 昵称 | QQ | 群 | 发言数 | 活跃度 | 活跃时段 | 最近发言 | 备注 |\n|---|---|---|---|---|---|---|---|---|\n`
  active.forEach((s, i) => {
    md2 += `| ${i + 1} | ${s.name} | ${s.qq} | ${gnameOf(s)} | ${s.count} | ${tier(s.count)} | ${topHours(s.hours)} | ${s.last} | ${brief(s.qq)} |\n`
  })
  md2 += `\n`
  for (const s of active) {
    md2 += `## ${s.name}（${s.qq}）\n\n`
    md2 += `- 所在群：${gnameOf(s)}\n- 发言：${s.count} 条（${tier(s.count)}）\n- 活跃时段：${topHours(s.hours)}\n- 最近发言：${s.last}\n`
    if (s.samples.length) md2 += `- 说话样本（学语气用，保留原话）：\n${s.samples.map((x) => `  - 「${x}」`).join('\n')}\n`
    const facts = brief(s.qq)
    if (facts) md2 += `- 基本资料：${facts}\n`
    if (known.has(s.qq)) md2 += `- 已有详细印象：知识库 \`friend-${s.qq}.md\`\n`
    md2 += '\n'
  }
  fs.writeFileSync(path.join(KB_DIR, 'friends-active.md'), md2, 'utf8')
  console.log('写出 friends-active.md（%d 人）', active.length)

  if (DRY) {
    console.log('--dry，跳过上传')
    return
  }

  // ---------- C) 上传知识库 ----------
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const h = b64({ alg: 'HS256', typ: 'JWT' })
  const n = Math.floor(Date.now() / 1000)
  const p = b64({ username: 'astrbot', exp: n + 600, iat: n })
  const H = { Authorization: `Bearer ${h}.${p}.${crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url')}`, 'Content-Type': 'application/json' }

  for (const [fname, text] of [[`group-${g0.id}-members.md`, md], ['friends-active.md', md2]]) {
    const list = await (await fetch(`${ASTR}/document/list?kb_id=${KB_ID}&page=1&page_size=200`, { headers: H })).json()
    for (const d of list?.data?.items ?? []) {
      if ((d.doc_name ?? d.file_name) === fname) {
        await fetch(`${ASTR}/document/delete`, { method: 'POST', headers: H, body: JSON.stringify({ kb_id: KB_ID, doc_id: d.doc_id }) })
      }
    }
    const chunks = text.split(/\n(?=## )/).map((s) => s.trim()).filter(Boolean)
    const imp = await (await fetch(`${ASTR}/document/import`, { method: 'POST', headers: H, body: JSON.stringify({ kb_id: KB_ID, documents: [{ file_name: fname, chunks }] }) })).json()
    console.log('已上传', fname, '->', JSON.stringify(imp?.data ?? imp).slice(0, 100))
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
