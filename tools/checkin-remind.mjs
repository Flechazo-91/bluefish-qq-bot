// 22:00 打卡/晚点名提醒：私聊示例好友 + 群里 @所有人。周一到周五由计划任务触发。
//   node checkin-remind.mjs                     正式发（示例好友私聊 + 示例群B群 @所有人）
//   node checkin-remind.mjs --group 2000003 --to 1000002   换目标（测试用）
//   node checkin-remind.mjs --dry               只打印不发
const TOKEN = 'YOUR_ONEBOT_TOKEN'
const argv = process.argv.slice(2)
const val = (n, d = '') => { const i = argv.indexOf(n); return i >= 0 ? (argv[i + 1] || d) : d }
const dry = argv.includes('--dry')
const friend = Number(val('--to', '1000003'))
const group = Number(val('--group', '2000002'))   // 示例群B

const PRIVATE_TEXT = '十点了，晚点名打卡了没？别拖到最后一分钟。'
const GROUP_TEXT = '22:00 晚点名打卡时间到，记得去打卡，别被点名点没了。'

async function call(action, params) {
  const r = await fetch('http://127.0.0.1:3000/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ action, params }),
  })
  return r.json()
}

const main = async () => {
  console.log(new Date().toLocaleString('zh-CN', { hour12: false }))
  if (dry) {
    console.log('[dry] 私聊', friend, PRIVATE_TEXT)
    console.log('[dry] 群', group, '[At:all]', GROUP_TEXT)
    return
  }
  const a = await call('send_private_msg', { user_id: friend, message: [{ type: 'text', data: { text: PRIVATE_TEXT } }] })
  console.log('私聊:', JSON.stringify(a).slice(0, 120))

  const b = await call('send_group_msg', {
    group_id: group,
    message: [
      { type: 'at', data: { qq: 'all' } },
      { type: 'text', data: { text: ' ' + GROUP_TEXT } },
    ],
  })
  console.log('群 @所有人:', JSON.stringify(b).slice(0, 200))
  if (a?.retcode !== 0 || b?.retcode !== 0) process.exit(1)
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
