---
title: "语音与 IoT 从 H5 迁到 SDK 的实现思路"
type: 报告
project: "DumateApi接入"
date: "2026-11-09"
tags: ["DumateApi接入"]
summary: "把已在百度控制台配好的实时语音配置，以及 H5 里打通箭牌 IoT 的闸门路径，迁到 BRTC Agent SDK 宿主。控制台保持发送 SDK 消息，业务模块从页面分流里抽出来。"
status: active
---

## 摘要

控制台上的人设、三个 Function、知识库模板已经按「发送 SDK 消息」配完，绑在当前互动应用上。换 SDK 进房后，这些云上配置可以原样继续用。要改的是宿主：现在听写、字幕和 `[F]` 帧进的是 H5 页面，选设备、高危确认和打箭牌 IoT 发生在本仓库的 Node 进程里。SDK 宿主接过同一套数据通道帧，业务模块跟着迁过去。AK、SK、license、IoT token 继续留在服务端。

# 语音与 IoT 从 H5 迁到 SDK 的实现思路

口径日期 2026-11-09。控制台原文以 [[后台控制台交付配置]] 为准，参数名以 [[配置参数清单]] 为准，三个 UAT 接口以 [[箭牌IoT接口#当前支持的箭牌 IoT 接口]] 为准。本文只写迁移时改什么、留什么。

这里的 SDK 指百度 BRTC Agent SDK 的宿主。官方 H5 SDK 在 `../BRTC.Agent.H5.SDK.V1.0.10`，数据通道帧是 `[T]`、`[Q]`、`[A]`、`[F]`、`[E]`、`[B]`。Android、iOS 宿主使用同一套帧，进房参数仍来自服务端 `generateAIAgentCall`。本仓库的 `public/app.js` 是现在的宿主，`server.mjs` 是现在的业务进程。

## 1. 现在各自在哪

| 能力 | 现在的位置 | 迁到 SDK 后 |
| --- | --- | --- |
| 人设、三个 Function、四库七意图 | 百度「大模型实时互动」控制台，绑当前 AppID | 同一 AppID 则不动。新 AppID 才要重新绑定 |
| 开场白、热词、长音频、关闭自动打断 | `src/aiagent.mjs` 的 `agentConfig()`，建实例时下发 | 留在建实例服务里，随进房参数一起生效 |
| 进房、按住说话、字幕、播报 | `public/app.js` 调 `BRTC_Start`、`BRTC_SendMessageToUser` | 换成 SDK 宿主的 Start、发消息、onmessage |
| 授权帧 | 页面转发，`src/session.mjs` 用固定 `BRTC_DEVID` 拼 ACTIVE | 宿主转发，拼帧仍在服务端 |
| 设备原话补槽、多台选择、高危确认 | `POST /api/intent`，页面在进房间之前就截住 | 抽成业务模块，由宿主在收到原话或 `[F]` 后调用 |
| 模型 Function 槽位 | 控制台「发送 SDK 消息」，房间推 `[F]`，页面再 `POST /api/frame` | 宿主 onmessage 收到 `[F]` 后交给同一业务模块 |
| 打箭牌 IoT | `src/iot-client.mjs` | 业务模块内部调用，token 不出端 |
| 产品问答 | 原话以 `[T]` 进房间，知识库在平台侧检索 | 宿主只转发 `[T]` 和展示 `[A]` |
| 报修卡片 | 页面 `repairKind()` 本地出卡，deeplink 不进房间 | 宿主本地出卡，打开 `arrowhome://` |
| 调用次数、使用时长 | `POST /api/topic` 转统计适配层 | 可后迁。与 IoT 无关 |

密钥不进 SDK 包。官方示例把 AK/SK 放进浏览器调 `generateAIAgentCall`，本仓库已经改成服务端签名。SDK 宿主保持这个分界。

## 2. 控制台配置：迁移时保持

这些是之前为实时语音配上、并且已经按 SDK 消息出口写好的内容。请求地址保持「发送 SDK 消息」。改成 HTTP 后，槽位由百度云端直接打到用户侧，选设备、高危确认和审计都不会经过宿主。

### 2.1 应用和人设

- 互动应用与 `.env` 的 `BRTC_APPID` 是同一条。
- 自定义角色已绑到这个应用。角色名称避开「箭牌智家助手」，该名与预置角色重名。人设正文里的自称仍是这一句。
- 建实例不传 `sceneRoleCfg`，也不传 `ragIntentTemplateId`。人设全文在 [[后台控制台交付配置]] 第 2 节。
- 人设约束：立刻开关走 `control_device`；每天、到点、自动执行走 `create_scene`；明确报修或查进度走 `open_repair`；型号、参数、故障、保修走知识库。回答里不输出 JSON 和设备号。设备操作只说准备发给平台。

### 2.2 三个 Function

模板名称「箭牌iot平台控制」，模板 ID `892`。三个函数的执行前确认都是否，是否定时执行都是否。

| Function | 函数 ID | 参数 | 宿主拿到后做什么 |
| --- | --- | --- | --- |
| `control_device` | `5020` | `deviceName`、`cmd`、`param`、`value`、`say` | 收成 `device.control`，过闸门，放行后 `POST /ext/v3/ai/control` |
| `create_scene` | `5021` | `conditionList`、`actionList`、`say`，前两个是 JSON 字符串 | 收成 `scene.create`，过闸门，放行后 `POST /ext/v3/ai/scene` |
| `open_repair` | `5022` | `kind`（`report` 或 `progress`）、`say` | 只出 deeplink，不打 IoT |

`say` 只给播报。打到箭牌的控制报文只有 `deviceName`、`cmd`、`param`、`value`。`cmd` 只允许八个：`switch_watering`、`switch_watering_small`、`switch_night_light`、`switch_auto_closing`、`switch_kicking`、`switch_auto_oiling_porcelain`、`switch_onoff`、`switch_water_in`。`param` 固定 `switch`。大冲、小冲只能 `on`。

房间推来的一帧形态：

```text
[F]:{"session_id":"...","content":"{\"function_name\":\"control_device\",\"parameter_list\":[{...}]}"}
```

`content` 经常是字符串，要再解析一次。解析逻辑在 `src/frames.mjs` 的 `parseFunction`、`actionFromCall`。回执也是一帧 `[F]`，带 `result`、`message`，需要固定播报时加 `post_function`。

### 2.3 知识库

模板 `arrow_product_kb`，ID `10000101`。执行位置保持平台侧检索，不要改成发送 SDK 消息。四个库、七条意图的名称、例句、快速匹配和挂库关系见交付配置第 4 节。SDK 宿主不上传知识文件，也不在本地挂说明书。

### 2.4 建实例时仍由服务端下发的语音参数

这些不在控制台表单里，在 `agentConfig()`：

| 字段 | 当前值 | 作用 |
| --- | --- | --- |
| `lang` | `zh` | 识别与播报语言 |
| `asr_long_audio_mode` | `true` | 按住才识别。松开后发 `ASR_STOP_LONGTEXT_REC` |
| `disable_voice_auto_int` | `true` | 关闭语音自动打断。打断改由宿主发 `[B]` |
| `tts_end_delay_ms` | `20` | 播报收尾 |
| `hotwords` | 大冲、小冲、冲水、夜灯、自动翻盖、脚触感应、自动润瓷、进水、放水、坐便器、马桶、镜柜、浴缸、报修 | 优先级高于控制台热词表 |
| `tts_sayhi` | `config/scenario.json` 的 `agent.sayhi` | 授权通过后的开场白 |
| `tag` | `H5.SDK` | 可改成宿主标识，不影响人设 |

按住说话的帧序留在宿主：先开麦，约 200 毫秒后发 `[E]:[CMD]:[ASR_START_LONGTEXT_REC]`，松开先发 `[E]:[CMD]:[ASR_STOP_LONGTEXT_REC]`，再关麦。平时麦克风静音。上限约 55 秒，松手后约 8 秒内等最终 `[Q]`。没听清、请再说一遍这类识别结果丢弃。

## 3. 现在打通 IoT 的操作路径

浏览器有两条边。音频和字幕直连 BRTC 房间。业务 HTTP 打本机 Node。浏览器不直接请求 `api-uatiot.arrowgroup.com.cn`。

### 3.1 进房

1. 页面 `GET /api/config`。`BRTC_APPID`、`BRTC_AK`、`BRTC_SK`、`BRTC_LICKEY` 缺一则输入框保持关闭。
2. `POST /api/session`。服务端对 `https://rtc-aiagent.baidubce.com/api/v1/aiagent/generateAIAgentCall` 做 BCE v3 签名。实例类型 `VoiceChat`。示例网关 `ai.agent.kaywang.cn` 对本 AppID 会回 No such app。
3. 响应里的 `appid`、房间名、`uid`、进房 token 交给 `BRTC_Start`。同时打开 datachannel、音频发布和自动订阅，视频关闭，麦克风先静音。
4. 房间推 `[E]:[LIC]:[MUST]`。页面把开通话时预拼的 `[E]:[LIC]:[ACTIVE]` 原样发回。没有预拼帧才走 `POST /api/session/lic`。
5. `[E]:[LIC]:[RES]:[PASS]` 之后约 3 秒解锁输入和麦克风。`FAILED` 则输入保持关闭。
6. 挂断时页面 `BRTC_Stop`，再 `POST /api/session/stop`，服务端调用 `stopAIAgentInstance`。

`BRTC_DEVID` 固定。激活按 licenseKey + appId + deviceId 计次，换号会再扣一次额度。

### 3.2 一句话怎么分流

`public/app.js` 的 `sendText()` 按这个顺序，命中即停。

| 顺序 | 条件 | 去向 | 进房间 |
| --- | --- | --- | --- |
| 1 | 调用次数、失败几次、检修报告、使用时长 | `POST /api/topic` | 否 |
| 2 | `repairKind()`：报修、维修，或进度、到哪、派工、受理 | 本地卡片，`arrowhome://repair/create` 或 `list` | 否 |
| 3 | `wantsDevice()`：打开、关闭、冲水、进水、夜灯、翻盖、脚触、润瓷、定时、每天、自动。带问号或「多少、怎么、几档」且没有「把、帮我、给我、来个」的说明书问句排除 | `POST /api/intent` | 否 |
| 4 | 其余，含产品问答 | `[T]:原话` | 是 |

设备这条是当前真正打到 IoT 的主路径。原话多数到不了模型，控制台里的 `control_device` 不会被调用。模型若仍在 60 秒内推来同一次 `control_device`，页面回一帧不播报的函数结果，避免再追问设备，也不再打第二次 IoT。

`POST /api/intent` 在 `server.mjs` 里组一个空的 `device.control`，交给 `src/turn.mjs` 的 `finish()`。补槽在 `src/resolve.mjs`：用原话填 `cmd`、`param`、`value`，再用房间、品类和能力收窄设备。一台就补上 `deviceName`。多台出选择卡。一台都对不上就拒绝。

### 3.3 闸门到 IoT

`src/policy.mjs` 的 `evaluate()` 是唯一决定能不能下发的地方。

1. 动作只能是 `device.control`、`scene.create`、`repair.open`。
2. `homeId` 必须是 `config/scenario.json` 里的 `933`。
3. 一次最多 3 条。`deviceName` 必须在设备名单里。`cmd`、`param`、`value` 必须在指令表内，且该品类的 `appliesTo` 包含这条指令。
4. `switch_water_in` 是 H，页面确认后才下发。确认单 5 分钟内有效，接口是 `POST /api/confirm`。
5. 其余 `switch` 是 M。唯一一台且校验通过时直接下发。
6. 报修直接放行，只写审计和卡片。

放行后 `src/iot-client.mjs` 发请求。公共头：

| 头 | 值 |
| --- | --- |
| Authorization | `bearer <IOT_TOKEN>` |
| appPlatform | `arrow` |
| ArrowDeviceSystemPlatform | `0` |
| Accept | `application/json` |

三个地址，根是 `https://api-uatiot.arrowgroup.com.cn`：

| 用途 | 方法与路径 | body |
| --- | --- | --- |
| 设备列表 | `GET /ext/v3/ai/device-list?homeId=933` | 无。结果缓存约 20 秒。选设备最多等 4 秒 |
| 控制 | `POST /ext/v3/ai/control` | `{ homeId, cmdList: [{ deviceName, cmd, param, value }] }` |
| 建场景 | `POST /ext/v3/ai/scene` | `{ homeId, conditionList, actionList }` |

HTTP 200 只表示接口可达。`code` 为 200 或 10000，且 `success` 不为 false，才记 SUCCEEDED。`code` 500 且 `msg` 为「设备离线」时记 FAILED，回执是「设备当前离线，指令已送到平台，这一次没有执行。」受理回执是「平台已受理。」

设备名单文件不在本目录。`IOT_FIXTURE=real` 读 `../箭牌demo打通/iot/devices.real.json`，否则读 `devices.json`。闸门用这份名单核对家庭归属和品类。在线状态以设备列表接口为准，当前不参与能不能下发。

### 3.4 模型 Function 这条辅路径

原话进了房间、模型填完槽之后：

1. 房间推 `[F]`。
2. 页面 `POST /api/frame`。
3. `actionFromCall` 把 `parameter_list[0]` 收成内部动作。`conditionList`、`actionList` 若是字符串，先 `JSON.parse`。
4. 同一个 `turn.finish()`。`deviceName` 不在名单里时丢掉，改按原话重选。
5. 页面把 `functionResultFrame()` 生成的 `[F]` 发回数据通道。

人设若没调函数、回答末尾仍有 `iot` 代码块，`extractAction()` 会从最终 `[A]` 里摘。摘不到就不下发。当前人设要求回答里不输出 JSON，这条只作兜底。

`create_scene` 代码已接上，开场示例里没有定时句，尚未按线上样例联调。闸门要求条件和动作的每一条都带 `deviceName`、`cmd`、`param`、`value`。控制台参数描述里的 `[{"time":"22:00"}]` 会被拒绝。场景接口文档里 `time` 的格式是 `YYYY-MM-DD HH:mm:ss`。

### 3.5 家庭设备清单

人设要求：用户消息里有「【家庭设备】」时，`deviceName` 和指令从那段逐字复制；没有这段，或多台都可能命中时，只反问，不调用函数。

`GET /api/roster` 能生成这段清单。当前 `sayToRoom()` 只发送 `[T]:原话`，没有附上清单。所以模型路径经常拿不到设备号。本机 `/api/intent` 不依赖模型填号，这是设备控制现在能打通的原因。

## 4. 迁到 SDK 后的目标路径

SDK 宿主替换 `public/app.js` 的房间职责。业务模块替换现在散在 HTTP 路由里的下发职责。控制台保持第 2 节。

```text
SDK 宿主
  服务端建实例、预拼 ACTIVE
  SDK Start 进房，麦先静音
  LIC MUST → 发回 ACTIVE → 等 PASS
  按住说话 / 文字
       │
       ├─ 统计话题 → 适配层（可后做）
       ├─ 报修、查进度 → 本地卡片 + arrowhome://
       ├─ 设备操作 → 业务模块 finish()
       └─ 产品问答、闲聊 → sendMessage("[T]:原话")
                              │
                              ▼
                         房间字幕 [Q]/[A]
                         房间函数 [F]
                              │
                              ▼
                         业务模块 finish()
                         闸门放行才打 IoT
                         sendMessage 回 [F] 结果
```

业务模块直接搬这五个文件，它们不依赖浏览器：

| 文件 | 迁过去的职责 |
| --- | --- |
| `src/frames.mjs` | 帧分类、解析 `[F]`、把函数收成动作、生成回执帧、从回答里摘 iot 块 |
| `src/resolve.mjs` | 原话补 `cmd`/`value`，多台时给出选择列表 |
| `src/policy.mjs` | 指令表、家庭归属、H 级确认单 |
| `src/turn.mjs` | 选择、闸门、下发、回执文案、审计条目 |
| `src/iot-client.mjs` | 三个 UAT 接口 |

`config/scenario.json` 的 `iot`、`policy`、`riskRules`、`commands`、`repair` 一起带走。`agent.system` 继续留空。页面品牌文案不必进 SDK。

`src/aiagent.mjs`、`src/session.mjs` 留在建实例服务。SDK 只接收进房参数和 ACTIVE 帧字符串。

下面这些留在 H5 页面里，SDK 宿主用自己的界面重做，不要把 `public/app.js` 整文件搬进 App：

- `startRtc`、`startHold`、`stopHold`、`onAgentFrame` 的帧分发
- 选择卡、确认卡、报修卡的 DOM
- 回合代号和 20 秒房间超时。`public/turn-gate.js` 的规则可以照搬：领代号、打断时发 `[B]`、代号对不上的字幕不展示。服务端发现代号已变时仍可能已经打过 IoT，返回里带 `superseded`，宿主不再播这句

IoT token、AK、SK、licenseKey 的读取留在服务端。若 App 必须直连箭牌网关，token 由宿主自己的登录态换取，不要打进 SDK 包，也不要写进场景 JSON。

## 5. 代码修改思路

### 5.1 建实例服务

保持 `generateCall()` 的签名和 BCE v3。SDK 宿主改为请求这个服务，不再自己持有 AK/SK。

建议改动：

- `agentConfig().tag` 从 `H5.SDK` 改成实际宿主名，便于日志区分。人设和热词不动。
- 返回体继续只含进房所需字段：`appid`、房间名、`uid`、token、实例 ID、预拼 ACTIVE 帧。现有 `POST /api/session` 已经是这个形状，SDK 可以继续调它，或把它收成宿主后端的一个接口。
- `stopAIAgentInstance` 仍由服务端调用。宿主挂断时带上实例 ID。

### 5.2 SDK 进房

对照 `startRtc()` 的开关：发布音频、使用 datachannel、自动订阅、自动发布、关闭视频、进房成功后立刻静音。授权通过前不开始识别。

onmessage 按前缀分发，顺序与 `onAgentFrame()` 相同：

| 帧 | 宿主动作 |
| --- | --- |
| `[E]:[LIC]:[MUST]` | 发送服务端给的 ACTIVE 帧 |
| `[E]:[LIC]:[RES]:[PASS]` 或 `FAILED` | 通知建实例服务记结果。PASS 之后再开麦按钮 |
| `[F]` 且 body 里已有 `result`、没有 `function_name` | 这是自己发出的回执回声，忽略 |
| `[F]` 且 `function_name` 为 `control_device`，本机刚处理过同一句 | 60 秒内回不播报的结果，见 5.4 |
| 其他 `[F]` | `parseFunction` → `actionFromCall` → `finish()` → 把回执帧发回 |
| `[Q]` | 按住期间回填识别文字。最终句进入与文字相同的分流 |
| `[A]` | 展示给用户。最终句若带 iot 块，再走 `extractAction`。中间态 `[M]` 不进闸门 |
| 其他 `[E]` | 授权以外的事件先只记录 |

本地要播一句固定话时，发 `[E]:[CMD]:[TEXT]:` 加这句话，与现在的 `speakLocal()` 相同。需要停掉上一句播报时发 `[B]`。

### 5.3 业务模块的调用面

把 `createTurn`、`createGate`、`createIotClient` 收成一个不依赖 HTTP 的入口，三个方法对应现在的三条路由：

| 现在的路由 | 新入口 | 调用时机 |
| --- | --- | --- |
| `POST /api/intent` | `handleUtterance(text)` | 原话被判成设备操作 |
| `POST /api/frame` 的 function 分支 | `handleFunctionFrame(raw, userText)` | 房间推来 `[F]` |
| `POST /api/choose`、`POST /api/confirm` | `choose(deviceName)`、`confirm(pendingId, decision)` | 用户点了选择卡或确认卡 |

`handleUtterance` 内部仍组空的 `device.control` 再 `finish()`，这样补槽行为与现网一致。选择卡和确认卡的文案继续用 `turn.finish()` 返回的 `cards`，宿主只负责画和回调。

设备列表继续走 `iot.deviceList(homeId)`，缓存 20 秒。名单文件里的 `room`、`categoryCode`、`capability`、`deviceTagName` 仍要在业务侧能读到。平台列表负责在线状态和当轮可选设备号。

### 5.4 避免打两次 IoT

现网有两条都能下发：页面 `/api/intent`，以及随后房间里的 `control_device`。页面用 `localIntentAt` 的 60 秒窗口把第二条收成一句不播报的回执，回执文案在 `roomControlAck()`。

SDK 上先保持这个窗口，行为才能和现网对齐。窗口里的回执不要带 `post_function`，避免再念一遍。窗口外的 `[F]` 才进入 `finish()`。

后续若改成只走模型 Function，再删掉窗口和 `/api/intent` 短路。删之前要先满足第 6.3 节的清单附带，否则模型没有设备号可抄。

### 5.5 报修和产品问答

报修继续在宿主本地判断，不进房间，不调用 `open_repair` 去打 IoT。deeplink 用场景文件里的两句：

- `arrowhome://repair/create?from=ai_assistant`
- `arrowhome://repair/list?from=ai_assistant`

`public/app.js` 的 `REPAIR_LINKS` 与 `scenario.json` 的 `repair` 现在是两份相同文案。迁的时候只留场景文件一份，宿主读它。

产品问答和闲聊只发 `[T]`。知识库回答由房间 `[A]` 播报。宿主不要在本地再答说明书。

「每天、到点、自动」现在被 `wantsDevice()` 当成设备控制，走的是立刻下发，不是 `create_scene`。SDK 第一阶段保持这个行为。定时场景等 `create_scene` 的时间格式和闸门字段对齐后再单独开一条入口。

### 5.6 审计

`src/audit.mjs` 现在追加本机 `audit.jsonl`。SDK 阶段改成业务服务落库。字段保持现在的 `kind`、`decision`、`result`、`targets`、`iotRequest`、`iotResponse`。请求头里的 token 继续脱敏，沿用 `redact()`。

### 5.7 明确不动的代码

- 不把三个 Function 改成 HTTP 回调。`docs/control-device-http示例.md` 只说明另一种出口，本迁移不走那条。
- 不在 SDK 里重写八个指令名，也不新增座温、暖风、除雾、灯光亮度。人设已要求这些去 App 或面板。
- 不把知识库意图改成 SDK 消息。
- 不把 `sceneRoleCfg` 写进建实例请求。

## 6. 配置修改思路

### 6.1 控制台

同一 AppID 继续给 SDK 用时，控制台零修改。核对清单：

1. 自定义角色已绑定，名称不是「箭牌智家助手」，正文与交付配置第 2 节一致。
2. 三个 Function 的请求地址都是发送 SDK 消息。
3. 知识库模板显示 `arrow_product_kb`，七条意图的执行位置仍是平台侧检索。
4. 改完任何人设后，结束当前通话再开一通。旧实例仍用旧人设。

若 SDK 使用新的互动应用，把同一角色、模板 `892`、模板 `10000101` 绑到新 AppID。函数文案、知识库文件不用另抄一份。新应用的 license 必须和这个 AppID、同一账号的 AK/SK 绑在一起。

### 6.2 环境变量

| 参数 | SDK 阶段 |
| --- | --- |
| `BRTC_APPID`、`BRTC_AK`、`BRTC_SK`、`BRTC_LICKEY` | 仍只在建实例服务 |
| `BRTC_DEVID` | 与现网相同则不重复扣激活。换宿主不等于换号 |
| `BRTC_API_HOST` | 继续 `https://rtc-aiagent.baidubce.com` |
| `BRTC_INSTANCE_TYPE` | 继续 `VoiceChat` |
| `IOT_MODE`、`IOT_BASE_URL`、`IOT_TOKEN` | 仍只在业务服务。默认 real，UAT 根地址不变 |
| `IOT_FIXTURE` | 真实家庭继续 `real` |
| `iot.homeId`、`appPlatform`、`deviceSystemPlatform` | 继续 933、`arrow`、`0` |
| `TOPIC_ADAPTER_URL`、`TOPIC_API_KEY` | 统计功能要保留时才带上 |

`.env` 不打进 SDK 包，不提交仓库。

### 6.3 若要让模型 Function 成为主路径

这是第二阶段，第一阶段不必做。要做时改两处：

1. 宿主在发送设备类 `[T]` 之前，把 `buildRole()` 生成的「【家庭设备】」附在原话后面。展示给用户的气泡在这个标记处截断，逻辑已在 `src/roster.mjs` 的 `userEcho()`。
2. 人设第 3 条已经要求从这段逐字复制。附上之后，`control_device` 的 `deviceName` 才有来源。多台命中时模型按人设反问，宿主展示 `[A]`，不再出本地选择卡。

这一阶段再删除 `handleUtterance` 对普通设备句的短路，以及 60 秒静默回执。高危确认仍留在闸门，不打开控制台的「执行前确认」。控制台确认发生在下发前的云端，本机的 H 级确认单、5 分钟有效期和审计对不上。

`create_scene` 同时改参数描述或改闸门，二选一，并写进同一次改动：要么条件里允许只有 `time`，由业务侧把 `actionList` 里的设备补进条件；要么控制台样例改成每一项都带设备字段，且 `time` 用 `YYYY-MM-DD HH:mm:ss`。现在两边不一致，所以定时场景先不要接到 SDK 主路径上。

## 7. 建议的落地顺序

1. 抽出第 4 节的五个业务文件和 `scenario.json`，用现有 `src/selfcheck.mjs` 跑闸门、补槽、回执。这一步不连房间，也不连真实 IoT。
2. SDK 宿主接上建实例、进房、LIC、按住说话、`[T]` 和 `[A]`。用「AKB1357的额定功率是多少」确认知识库仍由平台回答，第一句出现 900W。
3. 接上 `handleUtterance`。用三句现网开场示例验收：主卫坐便器大冲应直接打 `switch_watering`；主卫镜柜夜灯应打 `switch_night_light`；主卫浴缸进水应停在确认卡，确认后才打 `switch_water_in`。
4. 接上 `[F]`。在业务模块处理完一句设备话之后的 60 秒内，人为推一条 `control_device`，确认只回执、不第二次调用 `/ext/v3/ai/control`。
5. 报修两句只出卡片。产品问句不出现选择卡，也不出现 IoT 请求。
6. 设备离线时界面说已送到平台、这一次没有执行，审计为 FAILED。

第 2 步到第 5 步都在同一 AppID 上完成，控制台不用改。

## 8. 验收时对着看的句子

| 原话 | 期望 |
| --- | --- |
| 把主卫坐便器的大冲打开 | 唯一设备，M 级，`cmdList` 里是 `switch_watering` / `switch` / `on` |
| 把主卫镜柜的夜灯打开 | `switch_night_light` / `on` |
| 把主卫的浴缸进水打开 | 确认卡。取消则审计 CANCELLED，不打 IoT |
| 夜灯 | 多台可能命中时出选择卡，点一台后再下发 |
| AKB1357的额定功率是多少 | 进房间，第一句 900W，无 IoT 请求 |
| 我家坐便器不出水了，要报修 | 报修卡，deeplink 为 create |
| 查一下维修进度 | 进度卡，deeplink 为 list |
| 座温调到最高 | 不发明指令。进房间后由人设说明去 App 或面板 |

## 关联

- [[后台控制台交付配置]]
- [[配置参数清单]]
- [[箭牌IoT接口#当前支持的箭牌 IoT 接口]]
- [[模块流程架构]]
- [[control-device-http示例#control_device 两种出口]]
- [[DumateApi接入-索引]]
