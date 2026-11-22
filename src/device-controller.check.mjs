import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDeviceController } from './device-controller.mjs';
import { createGate } from './policy.mjs';
import { createTurn } from './turn.mjs';
import { actionFromCall, parseFunction } from './frames.mjs';

const scenario = JSON.parse(fs.readFileSync(new URL('../config/scenario.json', import.meta.url)));
const single = JSON.parse(fs.readFileSync(new URL('../config/fixtures/devices.validation-single.json', import.meta.url)));
const multi = JSON.parse(fs.readFileSync(new URL('../config/fixtures/devices.validation-multi.json', import.meta.url)));
const cases = [];

function setup(fixture = multi, options = {}) {
  const config = structuredClone(scenario);
  const devices = structuredClone(fixture.devices);
  let rows = structuredClone(devices);
  let clock = 1000;
  let liveOk = true;
  const controls = [];
  const gate = createGate({ scenario: config, devices });
  const iot = { control: async (homeId, cmdList) => {
    controls.push({ homeId, cmdList });
    return { ok: !options.iotTransportFailure, httpStatus: options.iotTransportFailure ? 503 : 200, ms: 1, request: { body: { homeId, cmdList } }, response: options.iotFailure
      ? { success: false, code: 500, msg: '模拟平台拒绝' } : { success: true, code: 200, msg: 'OK' } };
  } };
  const liveDevices = async () => ({ ok: liveOk, homeId: config.iot.homeId, rows, error: liveOk ? null : '设备列表鉴权失败' });
  const turn = createTurn({ scenario: config, devices, gate, iot, audit: { append: async () => {} }, liveDevices });
  const controller = createDeviceController({ scenario: config, devices, gate, turn, liveDevices,
    singleMode: options.singleMode || 'auto', ttlMs: 100, now: () => clock });
  return { controller, controls, config, setRows: (value) => { rows = value; }, setLiveOk: (value) => { liveOk = value; }, advance: () => { clock += 101; } };
}

const semantic = () => ({ action: 'device.control', categoryCode: '02', feature: 'warm_air', operation: 'on', targets: [{}] });
const input = (action = semantic(), extra = {}) => ({ sessionId: 'session-a', userText: '打开浴霸暖风', action, ...extra });
const card = (out) => out.cards.find((item) => item.event === 'demo.choose');

let env = setup();
let out = await env.controller.prepare(input());
assert.equal(out.state, 'WAITING_SELECTION');
assert.equal(out.catalog.totalCount, 13);
assert.equal(out.catalog.categories.length, 4);
assert.equal(card(out).data.count, 2);
assert.ok(card(out).data.choices.every((row) => row.categoryCode === '02'));
assert.equal(env.controls.length, 0);
cases.push('按品类和功能筛选，两台浴霸，不下发');

const id = out.requestId;
out = await env.controller.choose({ sessionId: 'other', requestId: id, deviceName: 'MOCK_BATH_HEATER_1' });
assert.equal(out.status, 403);
out = await env.controller.choose({ sessionId: 'session-a', requestId: id, deviceName: 'foreign-device' });
assert.equal(out.status, 400);
assert.equal(env.controls.length, 0);
cases.push('跨会话与非候选设备拒绝');

out = await env.controller.choose({ sessionId: 'session-a', requestId: id, deviceName: 'MOCK_BATH_HEATER_1' });
assert.equal(out.state, 'SUCCEEDED');
assert.deepEqual(env.controls[0].cmdList, [{ deviceName: 'MOCK_BATH_HEATER_1', cmd: 'switch_warm_air', param: 'switch', value: 'on' }]);
assert.equal((await env.controller.choose({ sessionId: 'session-a', requestId: id, deviceName: 'MOCK_BATH_HEATER_1' })).status, 409);
assert.equal(env.controls.length, 1);
cases.push('点选保留原动作，重复点击只执行一次');

env = setup(single);
out = await env.controller.prepare(input());
assert.equal(out.state, 'SUCCEEDED');
assert.equal(card(out), undefined);
assert.equal(out.catalog.candidateCount, 1);
assert.equal(env.controls[0].cmdList[0].deviceName, single.devices[1].deviceName);
cases.push('单台浴霸自动匹配并下发');

env = setup(single, { singleMode: 'card' });
out = await env.controller.prepare(input());
assert.equal(card(out).data.count, 1);
assert.equal(env.controls.length, 0);
assert.equal((await env.controller.choose({ sessionId: 'session-a', requestId: out.requestId, deviceName: single.devices[1].deviceName })).state, 'SUCCEEDED');
cases.push('单选卡点击后下发');

env = setup();
const repeated = input(semantic(), { callId: 'same-call', turnGen: 1 });
const duplicate = await Promise.all([env.controller.prepare(repeated), env.controller.prepare(repeated)]);
assert.equal(duplicate[0].requestId, duplicate[1].requestId);
assert.equal(duplicate[1].replayed, true);
env = setup(single);
await Promise.all([env.controller.prepare(repeated), env.controller.prepare(repeated)]);
assert.equal(env.controls.length, 1);
await env.controller.prepare({ ...repeated, turnGen: 2 });
assert.equal(env.controls.length, 2);
cases.push('函数重放去重，新轮次可再次操作');

for (const action of [
  { action: 'device.control', targets: [{}] },
  { ...semantic(), feature: 'unadapted' },
  { ...semantic(), categoryCode: '06' },
  { ...semantic(), homeId: 999 },
  { ...semantic(), targets: [{ cmd: 'switch_onoff' }] },
  { ...semantic(), targets: [{ value: 'off' }] },
]) {
  env = setup();
  out = await env.controller.prepare(input(action));
  assert.equal(out.state, 'REJECTED');
  assert.equal(card(out), undefined);
  assert.equal(env.controls.length, 0);
}
cases.push('缺功能、未知功能、品类冲突、跨家庭、指令或动作冲突均不出占位卡');

for (const userText of ['怎么打开浴霸暖风', '请问怎么打开浴霸暖风', '能介绍浴霸暖风耗电情况吗', '浴霸暖风耗电吗', '介绍一下浴霸的暖风功能', '浴霸暖风现在开着吗']) {
  env = setup(single);
  out = await env.controller.prepare(input(semantic(), { userText }));
  assert.equal(out.state, 'REJECTED');
  assert.equal(card(out), undefined);
  assert.equal(env.controls.length, 0);
}
env = setup(single);
assert.equal((await env.controller.prepare(input(semantic(), { userText: '能帮我打开浴霸暖风吗' }))).state, 'SUCCEEDED');
cases.push('云端误判知识或状态后不出设备卡、不执行；礼貌的立即控制允许');

env = setup(single);
out = await env.controller.prepare(input({ ...semantic(), room: '主卫' }, { userText: '打开主卫浴霸暖风' }));
assert.equal(out.state, 'REJECTED');
assert.equal(env.controls.length, 0);
cases.push('设备房间未知时不忽略用户的房间约束');

env = setup();
out = await env.controller.prepare(input({ ...semantic(), room: '主卫', deviceAlias: '模拟浴霸 A' }));
assert.equal(out.state, 'WAITING_SELECTION');
assert.equal(card(out).data.count, 2);
assert.equal(env.controls.length, 0);
cases.push('模型复制未被用户提及的房间和昵称，不缩成唯一设备或自动下发');

env = setup();
out = await env.controller.prepare(input({ ...semantic(), room: '客卫' }, { userText: '打开主卫浴霸暖风' }));
assert.equal(out.state, 'SUCCEEDED');
assert.equal(env.controls[0].cmdList[0].deviceName, 'MOCK_BATH_HEATER_1');
cases.push('用户明确位置优先于模型提供的冲突位置');

for (const categoryCode of ['01', '06']) {
  env = setup();
  out = await env.controller.prepare(input({ action: 'device.control', categoryCode,
    feature: 'night_light', operation: 'off', targets: [{}] }, { userText: '关闭夜灯' }));
  assert.equal(out.state, 'WAITING_SELECTION');
  assert.equal(card(out).data.count, 9);
  assert.deepEqual([...new Set(card(out).data.choices.map((row) => row.categoryCode))].sort(), ['01', '06']);
  assert.equal(env.controls.length, 0);
}
cases.push('共享功能未说品类时保留全部适配品类，模型猜测不缩小候选');

env = setup();
out = await env.controller.prepare(input({ action: 'device.control', categoryCode: '01',
  feature: 'night_light', operation: 'on', targets: [{}] }, { userText: '打开镜柜夜灯' }));
assert.equal(card(out).data.count, 3);
assert.ok(card(out).data.choices.every((row) => row.categoryCode === '06'));
assert.equal(env.controls.length, 0);
cases.push('共享功能按原话明确品类筛选，原话优先于模型猜测');

env = setup();
out = await env.controller.prepare(input({ action: 'device.control', categoryCode: '06',
  feature: 'night_light', operation: 'on', targets: [{}] }, { userText: '打开浴霸夜灯' }));
assert.equal(out.state, 'REJECTED');
assert.equal(card(out), undefined);
assert.equal(env.controls.length, 0);
cases.push('原话品类不支持功能时拒绝，不能转给其他品类');

env = setup();
out = await env.controller.prepare(input());
env.advance();
assert.equal((await env.controller.choose({ sessionId: 'session-a', requestId: out.requestId, deviceName: 'MOCK_BATH_HEATER_1' })).status, 410);
cases.push('过期选择请求拒绝');

env = setup();
out = await env.controller.prepare(input());
env.config.iot.homeId = 1000;
assert.equal((await env.controller.choose({ sessionId: 'session-a', requestId: out.requestId, deviceName: 'MOCK_BATH_HEATER_1' })).status, 409);
assert.equal(env.controls.length, 0);
cases.push('家庭切换后旧卡失效');

env = setup();
out = await env.controller.prepare(input());
env.setRows(multi.devices.filter((row) => row.deviceName !== 'MOCK_BATH_HEATER_1'));
assert.equal((await env.controller.choose({ sessionId: 'session-a', requestId: out.requestId, deviceName: 'MOCK_BATH_HEATER_1' })).state, 'REJECTED');
assert.equal(env.controls.length, 0);
cases.push('点击时重新查询目录，已移除设备拒绝');

env = setup(single);
env.setRows(single.devices.map((row) => ({ ...row, onlineStatus: 0 })));
out = await env.controller.prepare(input());
assert.equal(out.state, 'REJECTED');
assert.match(out.spoken, /离线/);
assert.equal(env.controls.length, 0);
cases.push('离线设备不下发');

env = setup(single, { iotFailure: true });
out = await env.controller.prepare(input());
assert.equal(out.state, 'FAILED');
assert.match(out.spoken, /模拟平台拒绝/);
cases.push('平台业务失败如实反馈');

env = setup(single, { iotTransportFailure: true });
out = await env.controller.prepare(input());
assert.equal(out.state, 'FAILED');
assert.match(out.spoken, /HTTP 503/);
assert.doesNotMatch(out.spoken, /已受理/);
cases.push('HTTP 失败时不信任响应体中的成功码');

env = setup();
env.setLiveOk(false);
out = await env.controller.prepare(input());
assert.equal(out.state, 'REJECTED');
assert.match(out.spoken, /鉴权失败/);
assert.equal(env.controls.length, 0);
cases.push('目录查询失败不回退旧演示名单');

env = setup(single);
env.setRows([{ deviceName: 'new-live-device', categoryCode: '02', deviceTagName: '新接入浴霸', onlineStatus: 1 }]);
out = await env.controller.prepare(input());
assert.equal(out.state, 'SUCCEEDED');
assert.equal(env.controls[0].cmdList[0].deviceName, 'new-live-device');
cases.push('动态设备按品类适配，不依赖写死的设备号');

env = setup(single);
out = await env.controller.prepare(input(semantic(), { isCurrent: () => false }));
assert.equal(out.state, 'SUPERSEDED');
assert.equal(env.controls.length, 0);
cases.push('已被下一句替代的准备请求不下发');

const frame = '[F]:' + JSON.stringify({ session_id: 'call-1', content: JSON.stringify({ function_name: 'control_device', parameter_list: [
  { categoryCode: '02' }, { feature: 'warm_air' }, { operation: 'on' },
] }) });
const action = actionFromCall(parseFunction(frame));
env = setup(single);
assert.equal((await env.controller.prepare(input(action))).state, 'SUCCEEDED');
cases.push('兼容既有 control_device 和拆分参数回调');
assert.equal(parseFunction('[F]:' + JSON.stringify({
  query: '打开浴霸暖风\\n【家庭设备】目录',
  content: { function_name: 'control_device', parameter_list: [] },
})).userText, '打开浴霸暖风');
cases.push('回调绑定云端原始 query，剔除目录上下文');

console.log(JSON.stringify({ result: 'PASS', cases: cases.length, checks: cases }, null, 2));
