// 真实 HTTP 路由验收：在临时副本里起服务，验小冲拒绝、裸开关、授权失败回 200、响应脱敏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_IOT = path.resolve(ROOT, '..', '箭牌demo打通', 'iot');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitReady(child) {
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (out.includes('[arrow-h5]')) return;
    if (child.exitCode !== null) throw new Error(`服务提前退出：${err || out}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`服务没有起来：${err || out}`);
}

async function post(port, pathname, body) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arrow-http-'));
const appDir = path.join(tmp, '箭牌h5平台');
const demoDir = path.join(tmp, '箭牌demo打通');
let child = null;

try {
  fs.mkdirSync(path.join(appDir, 'config'), { recursive: true });
  fs.mkdirSync(path.join(demoDir, 'iot'), { recursive: true });
  for (const file of ['server.mjs', 'scenario.mjs']) {
    fs.copyFileSync(path.join(ROOT, file), path.join(appDir, file));
  }
  fs.cpSync(path.join(ROOT, 'src'), path.join(appDir, 'src'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'config', 'scenario.json'), path.join(appDir, 'config', 'scenario.json'));
  for (const file of ['devices.json', 'mock-gateway.mjs']) {
    fs.copyFileSync(path.join(DEMO_IOT, file), path.join(demoDir, 'iot', file));
  }

  const port = await freePort();
  const iotPort = await freePort();
  fs.writeFileSync(path.join(appDir, '.env'), [
    `PORT=${port}`,
    `IOT_PORT=${iotPort}`,
    'IOT_MODE=mock',
    'IOT_TOKEN=test-token',
    'DEVICE_ROUTE=local',
    'DEVICE_FILL=on',
    '',
  ].join('\n'));

  child = spawn(process.execPath, ['server.mjs'], {
    cwd: appDir,
    env: {
      ...process.env,
      PORT: String(port),
      IOT_PORT: String(iotPort),
      IOT_MODE: 'mock',
      IOT_TOKEN: 'test-token',
      DEVICE_ROUTE: 'local',
      DEVICE_FILL: 'on',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitReady(child);

  // 小冲：平台不认，必须拒绝且不产生执行结果。
  const small = await post(port, '/api/intent', { sessionId: 'hs_http', text: '帮我小冲', turnGen: 0 });
  assert.equal(small.status, 200);
  const smallGate = small.body.cards.find((c) => c.event === 'demo.gate');
  assert.ok(smallGate, JSON.stringify(small.body));
  assert.equal(smallGate.data.decision, 'deny');
  assert.match(smallGate.data.reasons[0], /平台暂不支持小冲/);
  assert.equal(small.body.cards.some((c) => c.event === 'demo.result'), false);

  // 裸开关：没有具体功能词时落到 switch_onoff，具体指令仍然优先。
  const onoff = await post(port, '/api/intent', { sessionId: 'hs_http', text: '把主卫马桶关掉', turnGen: 0 });
  const onoffChoose = onoff.body.cards.find((c) => c.event === 'demo.choose');
  assert.ok(onoffChoose, JSON.stringify(onoff.body));
  assert.equal(onoffChoose.data.action.targets[0].cmd, 'switch_onoff');
  assert.equal(onoffChoose.data.action.targets[0].value, 'off');
  const specific = await post(port, '/api/intent', { sessionId: 'hs_http', text: '把自动翻盖关掉', turnGen: 0 });
  const specificChoose = specific.body.cards.find((c) => c.event === 'demo.choose');
  assert.equal(specificChoose.data.action.targets[0].cmd, 'switch_auto_closing');

  // 点选后执行成功，响应里的 Authorization 必须脱敏。
  const chosen = await post(port, '/api/choose', {
    sessionId: 'hs_http',
    action: onoffChoose.data.action,
    deviceName: onoffChoose.data.choices[0].deviceName,
    userText: '把主卫马桶关掉',
    choiceId: onoffChoose.data.choiceId,
  });
  assert.equal(chosen.status, 200);
  const chosenResult = chosen.body.cards.find((c) => c.event === 'demo.result');
  assert.ok(chosenResult, JSON.stringify(chosen.body));
  assert.equal(chosenResult.data.iotRequest.headers.Authorization, '***');
  assert.equal(JSON.stringify(chosen.body).includes('test-token'), false);

  // 唯一设备直接执行，/api/intent 的响应同样要脱敏。
  const direct = await post(port, '/api/intent', { sessionId: 'hs_http', text: '把主卫浴缸关掉', turnGen: 0 });
  const directResult = direct.body.cards.find((c) => c.event === 'demo.result');
  assert.ok(directResult, JSON.stringify(direct.body));
  assert.equal(directResult.data.iotRequest.headers.Authorization, '***');
  assert.equal(JSON.stringify(direct.body).includes('test-token'), false);

  // 授权失败不是 HTTP 错误，页面才能拿到 passed:false 并收起遮罩。
  const lic = await post(port, '/api/session/lic-result', { sessionId: 'hs_missing', frame: '[E]:[LIC]:[RES]:[FAILED]' });
  assert.equal(lic.status, 200);
  assert.equal(lic.body.passed, false);

  console.log('http ok');
} finally {
  if (child) {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
