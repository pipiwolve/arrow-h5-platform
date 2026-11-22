import crypto from 'node:crypto';
import { catalogRows, controlCandidates, resolveControl, summarizeCatalog } from './device-catalog.mjs';

// 模型请求控制；业务层准备候选并保存动作；用户点选只提交请求号和设备号。
export function createDeviceController({ scenario, devices, liveDevices, gate, turn, singleMode = 'auto', ttlMs = 300_000, now = Date.now }) {
  const pending = new Map();
  const calls = new Map();
  const copy = (value) => structuredClone(value);

  function prune() {
    for (const [key, rec] of pending) if (now() - rec.createdAt > ttlMs) pending.delete(key);
    for (const [key, rec] of calls) if (now() - rec.at > ttlMs) calls.delete(key);
  }

  async function load(force = false) {
    const live = await liveDevices(force);
    if (!live?.ok || !Array.isArray(live.rows)) throw new Error(live?.error || '没有成功取得当前家庭设备列表，请稍后重试。');
    if (live.homeId !== undefined && Number(live.homeId) !== Number(scenario.iot.homeId)) throw new Error('设备目录所属家庭发生变化，请重新发起控制。');
    return catalogRows({ rows: live.rows, devices, commands: scenario.commands });
  }

  function failure(message, catalog) {
    return { state: 'REJECTED', catalog, spoken: message, receipt: message, cards: [
      { event: 'demo.gate', data: { decision: 'deny', level: 'X', reasons: [message] } },
    ] };
  }

  async function execute(action, rows, context) {
    const picked = action.targets[0].deviceName;
    const row = rows.find((device) => device.deviceName === picked);
    if (!row?.onlineStatus) return failure('设备当前离线，这一次没有下发。');
    if (context.isCurrent && !context.isCurrent()) return { state: 'SUPERSEDED', superseded: true, cards: [] };
    gate.updateDevices(rows);
    const out = await turn.finish({ sessionId: context.sessionId, action, userText: context.userText, fill: 'off' });
    const result = out.cards.find((card) => card.event === 'demo.result');
    const state = result ? result.data.result : out.verdict?.decision === 'confirm' ? 'WAITING_CONFIRMATION' : 'REJECTED';
    const spoken = state === 'WAITING_CONFIRMATION' ? '这一步需要你在页面上确认后才会发给平台。' : out.receipt || out.spoken;
    return { ...out, state, spoken };
  }

  async function prepareOnce(input) {
    let summary;
    try {
      if (Number(input.action.homeId ?? scenario.iot.homeId) !== Number(scenario.iot.homeId)) return failure('请求家庭与当前家庭不一致，这一次没有下发。');
      const action = resolveControl(input.action, input.userText, scenario.commands);
      const rows = await load(true);
      if (input.isCurrent && !input.isCurrent()) return { state: 'SUPERSEDED', superseded: true, cards: [] };
      const choices = controlCandidates(action, rows, input.userText);
      summary = { ...summarizeCatalog(rows), categoryCode: action.categoryCode, feature: action.feature, candidateCount: choices.length };
      if (!choices.length) return failure('当前家庭没有满足品类、功能和位置要求的设备，这一次没有下发。', summary);
      if (choices.length === 1 && singleMode !== 'card') {
        const ready = { ...action, targets: action.targets.map((item) => ({ ...item, deviceName: choices[0].deviceName })) };
        return { ...await execute(ready, rows, input), catalog: summary };
      }
      const requestId = 'dc_' + crypto.randomBytes(12).toString('hex');
      pending.set(requestId, {
        requestId, sessionId: input.sessionId, homeId: scenario.iot.homeId,
        action: copy(action), userText: String(input.userText || ''),
        deviceNames: choices.map((row) => row.deviceName), createdAt: now(), status: 'WAITING_SELECTION',
      });
      const category = choices.every((row) => row.categoryCode === choices[0].categoryCode) ? choices[0].category : '设备';
      const spoken = `找到 ${choices.length} 台符合条件的${category}，请在页面选择一台。`;
      return {
        state: 'WAITING_SELECTION', requestId, catalog: summary, spoken, receipt: spoken,
        cards: [{ event: 'demo.choose', data: {
          requestId, choiceId: requestId, homeId: scenario.iot.homeId,
          count: choices.length, categoryCode: action.categoryCode, category,
          choices: copy(choices), say: spoken,
        } }],
      };
    } catch (error) {
      return failure(error.message, summary);
    }
  }

  function prepare(input) {
    prune();
    const key = input.callId ? `${input.sessionId}:${input.turnGen || 0}:${input.callId}` : '';
    if (key && calls.has(key)) return calls.get(key).promise.then((out) => ({ ...copy(out), replayed: true }));
    const promise = prepareOnce(input);
    if (key) calls.set(key, { at: now(), promise });
    return promise;
  }

  async function choose({ sessionId, requestId, deviceName }) {
    const rec = pending.get(requestId);
    if (!rec || now() - rec.createdAt > ttlMs) return { status: 410, body: { error: '选择请求已过期，请重新发起。' } };
    if (rec.sessionId !== sessionId) return { status: 403, body: { error: '选择请求不属于当前会话。' } };
    if (rec.status !== 'WAITING_SELECTION') return { status: 409, body: { error: '这张选择卡已处理，请不要重复提交。' } };
    if (Number(rec.homeId) !== Number(scenario.iot.homeId)) return { status: 409, body: { error: '家庭已切换，请重新发起。' } };
    if (!rec.deviceNames.includes(deviceName)) return { status: 400, body: { error: '所选设备不在这张卡片的候选列表内。' } };
    rec.status = 'CHECKING';
    try {
      const rows = await load(true);
      const candidates = controlCandidates(rec.action, rows, rec.userText);
      if (!candidates.some((row) => row.deviceName === deviceName)) {
        rec.status = 'REJECTED';
        return failure('设备目录已更新，所选设备不再满足条件，请重新发起。');
      }
      const action = { ...copy(rec.action), targets: rec.action.targets.map((item) => ({ ...item, deviceName })) };
      const out = await execute(action, rows, rec);
      rec.status = out.state;
      return { ...out, requestId };
    } catch (error) {
      rec.status = 'WAITING_SELECTION';
      return { status: 503, body: { error: error.message } };
    }
  }

  return { prepare, choose };
}
