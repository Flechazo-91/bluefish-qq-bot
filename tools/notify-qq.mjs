// 通用 QQ 通知：任何工作区/脚本跑完任务后，用它给主人（或指定人/群）发一条 QQ。
//
// 用法：
//   node D:/AstrBot/notify-qq.mjs "任务完成：B 站切片已上传"
//   node D:/AstrBot/notify-qq.mjs --title "切片完成" "共 12 条，已入库"
//   echo "多行内容" | node D:/AstrBot/notify-qq.mjs --stdin
//   node D:/AstrBot/notify-qq.mjs --to 1000003 "给示例好友发"
//   node D:/AstrBot/notify-qq.mjs --group 2000002 --at-all "群里通知"
//
// 退出码：0 成功；2 OneBot 没起/发不出去（调用方据此判断要不要重试）
const TOKEN = process.env.ONEBOT_TOKEN || 'YOUR_ONEBOT_TOKEN'
const HOST = process.env.ONEBOT_HOST || 'http://127.0.0.1:3000/'
const OWNER = 1000002

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f, d = '') => { const i = argv.indexOf(f); return i >= 0 ? (argv[i + 1] || d) : d }

const readStdin = async () => {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

const main = async () => {
  const to = Number(val('--to', has('--group') ? '0' : String(OWNER)))
  const group = Number(val('--group', '0'))
  const title = val('--title', '')
  const atAll = has('--at-all')

  let text = has('--stdin') ? (await readStdin()).trim() : argv.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a)).join(' ')
  text = text.trim()
  if (!text) { console.error('没有要发的内容'); process.exit(1) }
  if (text.length > 1200) text = text.slice(0, 1200) + '…'

  const body = title ? `【${title}】\n${text}` : text
  const message = group && atAll
    ? [{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: ' ' + body } }]
    : [{ type: 'text', data: { text: body } }]

  const action = group ? 'send_group_msg' : 'send_private_msg'
  const params = group ? { group_id: group, message } : { user_id: to, message }

  try {
    const r = await fetch(HOST, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ action, params }),
    })
    const j = await r.json()
    if (j?.retcode === 0) {
      console.log(`已发送 -> ${group ? '群 ' + group : 'QQ ' + to}  msg_id=${j?.data?.message_id}`)
      process.exit(0)
    }
    console.error('发送失败:', JSON.stringify(j).slice(0, 200))
    process.exit(2)
  } catch (e) {
    console.error('OneBot 不可达（3000 端口没起？）:', e.message)
    process.exit(2)
  }
}

main()
