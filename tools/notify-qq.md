# 任务完成后发 QQ 通知（给其他工作区用）

你在别的工作区（B 站切片、抖音、课表、任何脚本）干完活，想给主人发条 QQ 提醒，**调用这个就行，不用碰 AstrBot 的代码**。

## 一行命令（Windows，任何目录都能用）

```cmd
D:/AstrBot\notify-qq.cmd "任务完成：B 站切片 12 条已入库"
```

带标题、带多行：

```cmd
D:/AstrBot\notify-qq.cmd --title "切片完成" "共 12 条，失败 0 条，产物在 D:\bili\out"
echo 第一行& echo 第二行 | D:/AstrBot\notify-qq.cmd --stdin --title "构建日志"
```

发群里、发指定人、群里 @所有人：

```cmd
D:/AstrBot\notify-qq.cmd --group 2000002 "切片跑完了"
D:/AstrBot\notify-qq.cmd --group 2000002 --at-all "全体注意：服务已重启"
D:/AstrBot\notify-qq.cmd --to 1000003 "给你的消息"
```

## 其他语言的写法

**PowerShell**

```powershell
& D:/AstrBot\notify-qq.cmd --title "完成" "任务跑完了"
# 失败重试一次
if ($LASTEXITCODE -ne 0) { Start-Sleep 5; & D:/AstrBot\notify-qq.cmd --title "完成(重试)" "任务跑完了" }
```

**Bash / Git Bash**

```bash
node /d/AstrBot/notify-qq.mjs "任务完成：xxx"
```

**Python**

```python
import subprocess
subprocess.run([r"D:/AstrBot\notify-qq.cmd", "--title", "完成", "下载了 30 集"], check=False)
```

**Node / JS**

```js
import { execFileSync } from 'node:child_process'
execFileSync('D:/AstrBot/notify-qq.cmd', ['--title', '完成', '任务跑完了'], { stdio: 'inherit' })
```

## 接口细节（要自己写 HTTP 也行）

- 地址：`http://127.0.0.1:3000/`（SnowLuma 的 OneBot 端口，**必须机器人开着**）
- 鉴权：`Authorization: Bearer YOUR_ONEBOT_TOKEN`
- 私聊：`{"action":"send_private_msg","params":{"user_id":1000002,"message":[{"type":"text","data":{"text":"..."}}]}}`
- 群：`{"action":"send_group_msg","params":{"group_id":2000002,"message":[{"type":"at","data":{"qq":"all"}},{"type":"text","data":{"text":" ..."}}]}}`
- 常用群：**示例群B 2000002**、测试001 2000003
- 主人 QQ：**1000002**，示例好友：**1000003**

## 约定

- **退出码 0 才是发出去了**；`2` 表示 OneBot 没起/发不出去（别当成功）
- 消息正文超过 1200 字会被截断（QQ 长消息会折叠，尽量写短）
- 环境变量可覆盖：`ONEBOT_HOST`（默认 `http://127.0.0.1:3000/`）、`ONEBOT_TOKEN`
- 想加前缀方便识别：`--title "工作区名"`，实际发出去是 `【工作区名】\n正文`
