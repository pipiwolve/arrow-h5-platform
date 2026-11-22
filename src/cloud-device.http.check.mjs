import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cases = [];
const artifacts = [];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'arrow-cloud-http-'));

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function launch(profile, singleMode = 'auto') {
  const port = await freePort();
  const iotPort = await freePort();
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root,
    env: { ...process.env, PORT: String(port), IOT_PORT: String(iotPort), IOT_MODE: 'mock',
      IOT_TOKEN: 'local-validation-token', DEVICE_ROUTE: 'cloud', DEVICE_SINGLE: singleMode,
      IOT_FIXTURE_FILE: `config/fixtures/devices.validation-${profile}.json`, STATE_DIR: path.join(temp, `${profile}-${singleMode}`) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const deadline = Date.now() + 8000;
  while (!stdout.includes('[arrow-h5]')) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`服务启动失败：${stderr || stdout}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const post = async (route, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { port, post, get: async (route) => (await fetch(`http://127.0.0.1:${port}${route}`)).json(),
    stop: async () => { child.kill('SIGTERM'); await once(child, 'exit'); } };
}

function frame(params, id = 'function-1') {
  return '[F]:' + JSON.stringify({ session_id: id, content: JSON.stringify({ function_name: 'control_device', parameter_list: params }) });
}

let app;
try {
  app = await launch('multi');
  const deviceList = await app.get('/api/devices?fresh=1');
  assert.equal(deviceList.totalCount, 13);
  assert.equal(deviceList.categories.length, 4);
  cases.push('实际 HTTP 设备接口返回 13 台、4 个品类');

  const request = { sessionId: 'http-session', userText: '打开浴霸暖风', frame: frame([
    { categoryCode: '02' }, { feature: 'warm_air' }, { operation: 'on' },
  ]) };
  const prepared = await app.post('/api/frame', request);
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  assert.equal(prepared.body.state, 'WAITING_SELECTION');
  assert.equal(prepared.body.catalog.candidateCount, 2);
  assert.equal(prepared.body.cards[0].data.count, 2);
  const reply = JSON.parse(prepared.body.reply.slice(4));
  assert.equal(reply.result, 'ok');
  assert.equal(reply.post_function[0].type, 'text');
  assert.match(reply.post_function[0].content, /2 台/);
  assert.equal((await app.get('/api/audit')).items.length, 0);
  cases.push('Function Call 后查目录并出两台浴霸卡；回传成功准备状态，尚未控制');
  artifacts.push({ name: 'multi-prepare', response: prepared.body });

  const replay = await app.post('/api/frame', request);
  assert.equal(replay.body.requestId, prepared.body.requestId);
  assert.equal(replay.body.replayed, true);
  cases.push('HTTP 函数重放复用同一请求');

  const choose = await app.post('/api/choose', {
    sessionId: 'http-session', requestId: prepared.body.requestId, deviceName: 'MOCK_BATH_HEATER_2',
    action: { action: 'device.control', targets: [{ cmd: 'switch_water_in', value: 'off' }] }, userText: '后面的其他问题',
  });
  assert.equal(choose.status, 200);
  assert.equal(choose.body.state, 'SUCCEEDED');
  const result = choose.body.cards.find((card) => card.event === 'demo.result').data;
  assert.deepEqual(result.iotRequest.body.cmdList, [{ deviceName: 'MOCK_BATH_HEATER_2', cmd: 'switch_warm_air', param: 'switch', value: 'on' }]);
  assert.equal(result.iotRequest.headers.Authorization, '***');
  assert.equal(JSON.stringify(choose.body).includes('local-validation-token'), false);
  cases.push('点击经真实 HTTP 网关下发，忽略页面篡改动作和后续原句，响应脱敏');
  artifacts.push({ name: 'multi-select', response: choose.body });

  assert.equal((await app.post('/api/choose', { sessionId: 'http-session', requestId: prepared.body.requestId, deviceName: 'MOCK_BATH_HEATER_2' })).status, 409);
  const audit = await app.get('/api/audit');
  assert.equal(audit.items.filter((item) => item.decision === 'EXECUTED').length, 1);
  cases.push('重复点选无第二次 IoT 下发');

  const beforeKnowledge = audit.items.length;
  const knowledge = await app.post('/api/frame', { sessionId: 'http-session', userText: '浴霸暖风有什么用',
    frame: '[A]:这是暖风功能说明。\n```iot\n' + JSON.stringify({ action: 'device.control', targets: [{ deviceName: 'MOCK_BATH_HEATER_1', cmd: 'switch_warm_air', param: 'switch', value: 'on' }] }) + '\n```' });
  assert.equal(knowledge.body.cards.length, 0);
  assert.equal((await app.get('/api/audit')).items.length, beforeKnowledge);
  cases.push('知识回答中的控制 JSON 不触发卡片或下发');

  const missing = await app.post('/api/frame', { ...request, frame: frame([{ categoryCode: '02' }], 'missing-command') });
  assert.equal(missing.body.state, 'REJECTED');
  assert.equal(missing.body.cards.some((card) => card.event === 'demo.choose'), false);
  assert.equal(JSON.parse(missing.body.reply.slice(4)).result, 'error');
  cases.push('缺少功能先澄清，不列出全部设备');

  assert.equal((await app.post('/api/intent', { sessionId: 'http-session', text: '打开浴霸暖风' })).status, 409);
  cases.push('云端模式关闭旧正则控制入口');

  const water = await app.post('/api/frame', { ...request, userText: '打开浴缸进水', frame: frame([
    { categoryCode: '04' }, { cmd: 'switch_water_in' }, { value: 'on' },
  ], 'water-confirmation') });
  const waterChoice = await app.post('/api/choose', { sessionId: 'http-session', requestId: water.body.requestId,
    deviceName: water.body.cards[0].data.choices[0].deviceName });
  assert.equal(waterChoice.body.state, 'WAITING_CONFIRMATION');
  const pendingId = waterChoice.body.cards.find((item) => item.event === 'demo.gate').data.pendingId;
  const confirmed = await app.post('/api/confirm', { sessionId: 'http-session', pendingId, decision: 'confirm' });
  assert.equal(confirmed.body.state, 'SUCCEEDED');
  assert.equal(confirmed.body.spoken, '平台已受理。');
  cases.push('高风险进水选择后等待确认，确认下发后返回可播报受理反馈');
  await app.stop(); app = null;

  app = await launch('single');
  const direct = await app.post('/api/frame', { ...request, userText: '打开镜柜夜灯', frame: frame([
    { categoryCode: '06' }, { cmd: 'switch_night_light' }, { param: 'switch' }, { value: 'on' },
  ], 'single-mirror') });
  assert.equal(direct.body.state, 'SUCCEEDED');
  assert.equal(direct.body.catalog.totalCount, 3);
  assert.equal(direct.body.catalog.candidateCount, 1);
  assert.equal(direct.body.cards.some((card) => card.event === 'demo.choose'), false);
  assert.equal(JSON.parse(direct.body.reply.slice(4)).result, 'ok');
  cases.push('三台、每品类一台：镜柜唯一匹配直接下发');
  artifacts.push({ name: 'single-auto', response: direct.body });
  await app.stop(); app = null;

  app = await launch('single', 'card');
  const one = await app.post('/api/frame', { ...request, frame: frame([
    { categoryCode: '02' }, { cmd: 'switch_warm_air' }, { param: 'switch' }, { value: 'on' },
  ], 'single-card') });
  assert.equal(one.body.cards[0].data.count, 1);
  const selected = await app.post('/api/choose', { sessionId: 'http-session', requestId: one.body.requestId, deviceName: one.body.cards[0].data.choices[0].deviceName });
  assert.equal(selected.body.state, 'SUCCEEDED');
  cases.push('三台、每品类一台：强制单选卡可以点击下发');
  artifacts.push({ name: 'single-card', response: one.body });
  artifacts.push({ name: 'single-card-selected', response: selected.body });

  const report = { at: new Date().toISOString(), environment: 'local mock IoT; supplied Function Call frames', result: 'PASS', cases: cases.length, checks: cases, artifacts };
  if (process.env.VALIDATION_REPORT) fs.writeFileSync(process.env.VALIDATION_REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: report.result, cases: report.cases, checks: cases }, null, 2));
} finally {
  if (app) await app.stop();
  fs.rmSync(temp, { recursive: true, force: true });
}
