# 架构图索引

五张图分工固定，按这个顺序看：

| 图 | 回答的问题 | 主要读者 |
| --- | --- | --- |
| `01-整体架构.html` | 谁在哪个边界里，密钥放在哪，三套编号怎么隔离 | 客户技术负责人、售前 |
| `02-本地模式全链路时序.html` | 一句设备话从 ASR 到真机，本机做了哪些判断 | 联调、运维 |
| `03-云端模式全链路时序.html` | Function Call 回到本机后，为什么还要补槽和过闸 | 联调、百度侧 |
| `04-新增指令接入流程.html` | 加一条指令要改哪 6 个文件 8 处 | 研发 |
| `05-新增品类接入流程.html` | 加一个品类要改哪 6 个文件 8 处 | 研发 |

## 一页纸边界

- 浏览器只拿本次通话的 join token，AK/SK/lickey/IoT token 只进 Node 进程。
- 所有 `/api/*` 没有鉴权，靠部署层（内网、反代、临时口令）挡。
- 房间名、本地 `hs_*` 会话、`[F]` 外层 `session_id` 是三套编号，代码没有互相映射。
- 百度控制台是仓库外配置面：人设、函数参数、例句、知识库都在那里，导出件要进交付包。
- 设备 `room` 只存在于 fixture，平台设备列表不返回房间。

## 三条链路

1. 设备控制：页面 `/api/intent`（local）或房间 `[F]`（cloud）汇到 `turn.finish`，补槽、四道闸门、`iot.control` 或 `iot.scene`。
2. 报修：页面本地正则出卡，不进房间；云端 `open_repair` 的卡会被页面跳过。两条支路的文案要一起改。
3. 统计：页面 `/api/topic` → 适配器 `:8911` → DuMate 写 HTML 报告，数字来自 `data/iot-month.csv`。

## 与图不一致的旧文档

以图为准，这几处旧文档尚未改：

- `docs/模块流程架构.md:493` 说 `[T]` 不带设备清单，实际 `public/app.js:802-810` 在 cloud 模式会附上 `/api/roster`。
- `docs/云上配置与注入.archify.json:31`、`:68` 同上。
- `docs/箭牌IoT接口.md:45` 说 device-list 返回房间，实际 fixture 与 `fetch-devices.mjs:51-56` 都表明不返回。
- `README.md` 的「一轮对话」仍只画云端 `[F]` 一条路径；本地 `/api/intent` 见新增的「本地 / 云端两种模式」一节。

## 重新生成

```bash
node ~/.claude/skills/archify/bin/archify.mjs validate architecture docs/架构图/01-整体架构.json --quality showcase
node ~/.claude/skills/archify/bin/archify.mjs deliver architecture docs/架构图/01-整体架构.json --quality showcase
```

`02`、`03` 把 `architecture` 换成 `sequence`，`04`、`05` 换成 `workflow`。
