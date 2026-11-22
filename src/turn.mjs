// 一轮字幕收尾：从回答里取动作，过闸门，放行的才打到 IoT。
// 高危动作停在待确认，等 /api/confirm。

import { completeList, fillTargets, narrowDevices, retiredCommandReason, trustedName } from './resolve.mjs';

export function createTurn({ scenario, devices, gate, iot, audit, liveDevices }) {
  function execControl(rec) {
    const cmdList = rec.items.map(({ deviceName, cmd, param, value }) => ({ deviceName, cmd, param, value }));
    return iot.control(scenario.iot.homeId, cmdList);
  }

  function execScene(rec) {
    const pick = (i) => ({
      deviceName: i.deviceName, cmd: i.cmd, param: i.param, value: i.value,
      ...(i.time ? { time: i.time } : {}),
    });
    return iot.createScene(
      scenario.iot.homeId,
      (rec.action.conditionList || []).map(pick),
      (rec.action.actionList || []).map(pick),
    );
  }

  async function execute(rec, { trigger, actor = 'app-user', sessionId }) {
    const isScene = rec.action.action === 'scene.create';
    const res = isScene ? await execScene(rec) : await execControl(rec);
    const body = res.response && typeof res.response === 'object' ? res.response : null;
    const accepted = !!res.ok && !!body
      && body.success !== false
      && (body.code === undefined || body.code === 200 || body.code === 10000);
    const source = isScene
      ? [...(rec.action.conditionList || []), ...(rec.action.actionList || [])]
      : rec.action.targets || [];
    const targets = source.map((t) => {
      const dev = devices.find((d) => d.deviceName === t.deviceName)
        || rec.items.find((item) => item.deviceName === t.deviceName) || {};
      return {
        deviceName: t.deviceName, deviceTagName: dev.deviceTagName || '',
        room: dev.room || '', cmd: t.cmd, param: t.param, value: t.value,
      };
    });
    const entry = {
      kind: isScene ? 'scene.create' : 'device.control',
      actor, sessionId, homeId: scenario.iot.homeId,
      level: rec.level, reasons: rec.reasons, decision: 'EXECUTED', trigger, targets,
      iotRequest: res.request, iotResponse: res.response,
      result: accepted ? 'SUCCEEDED' : 'FAILED',
      httpStatus: res.httpStatus ?? null, error: res.error || null, ms: res.ms,
    };
    await audit.append(entry);
    return { ...entry, ok: accepted };
  }

  function receipt(card) {
    const data = card?.data || {};
    if (card?.event === 'demo.repair') return data.note || '已给出报修入口。';
    if (card?.event === 'demo.gate' && data.decision === 'deny') {
      return (data.reasons || []).join('；') || '这一次没有下发。';
    }
    if (card?.event !== 'demo.result') return '';
    const body = data.iotResponse && typeof data.iotResponse === 'object' ? data.iotResponse : null;
    const msg = body?.msg || body?.message || data.error || '';
    const accepted = data.result === 'SUCCEEDED';
    if (accepted) return '平台已受理。';
    if (data.httpStatus >= 400) return `平台请求失败（HTTP ${data.httpStatus}），这一次没有成功下发。`;
    if (/设备离线/.test(msg)) return '设备当前离线，指令已送到平台，这一次没有执行。';
    return msg ? `平台返回：${msg}` : '平台没有受理。';
  }

  /**
   * @param {{sessionId: string, action: object|null, userText?: string}} input
   * @returns 给前端渲染的卡片列表
   */
  async function finish(input) {
    const { sessionId, action } = input;
    const cards = [];
    if (!action) return { cards };

    if (action.action === 'repair.open') {
      const which = action.kind === 'progress' ? 'progress' : 'report';
      const copy = scenario.repair[which] || {};
      const deeplink = scenario.repair.deeplink[which];
      const note = copy.note || scenario.repair.note;
      await audit.append({
        kind: 'repair.open', actor: 'app-user', sessionId, level: 'L',
        decision: 'ALLOW', result: 'SUCCEEDED', deeplink, repairKind: which,
      });
      cards.push({
        event: 'demo.repair',
        data: {
          kind: which,
          deeplink,
          title: copy.cardTitle || scenario.repair.cardTitle || '报修',
          body: copy.cardBody || scenario.repair.cardBody || note,
          linkText: copy.linkText || (which === 'progress' ? '查看报修进度' : '打开报修页'),
          note,
          say: action.say || '',
        },
      });
      return { cards, receipt: note };
    }

    const retired = retiredCommandReason(action, input.userText);
    if (retired) {
      cards.push({ event: 'demo.gate', data: { decision: 'deny', level: 'X', reasons: [retired] } });
      return { cards, spoken: retired, receipt: retired };
    }

    // fill: on = 本机补槽收窄（默认）；off = 只校验；card = 云端填的那台排第一，出卡让人点。
    const mode = input.fill || 'on';
    if (mode === 'card' && action.action === 'device.control') {
      const target = (action.targets || [])[0] || {};
      const live = await loadLive(liveDevices);
      const choices = narrowDevices({ devices, live, userText: input.userText, cmd: target.cmd });
      if (choices.length) {
        const pick = trustedName(target.deviceName, devices);
        const ordered = pick
          ? [...choices.filter((c) => c.deviceName === pick), ...choices.filter((c) => c.deviceName !== pick)]
          : choices;
        const say = '点一下要把指令发给哪台设备。';
        cards.push({
          event: 'demo.choose',
          data: {
            choiceId: 'ch_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            action: {
              ...action,
              targets: (action.targets || []).map((item) => ({ ...item, deviceName: '' })),
            },
            choices: ordered,
            preferred: pick || '',
            say,
          },
        });
        return { cards, spoken: say };
      }
    }
    const completed = mode === 'on' ? completeAction(action, input.userText) : action;
    const chosen = mode === 'on' ? await chooseDevice(completed, input.userText) : { action: completed };
    if (chosen.none) {
      const say = '名下没有对得上的设备，这一次没有下发。';
      cards.push({ event: 'demo.gate', data: { decision: 'deny', level: 'X', reasons: [say] } });
      return { cards, spoken: say, receipt: say };
    }
    if (chosen.choices) {
      cards.push({
        event: 'demo.choose',
        data: {
          choiceId: 'ch_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          action: chosen.action,
          choices: chosen.choices,
          say: '有多台设备符合，选一台再下发。',
        },
      });
      return { cards, spoken: '有多台设备符合，选一台再下发。' };
    }
    const verdict = gate.evaluate(chosen.action);
    cards.push({
      event: 'demo.gate',
      data: {
        decision: verdict.decision, level: verdict.level,
        reasons: verdict.reasons, pendingId: verdict.pendingId || null,
        say: action.say || '',
      },
    });
    if (verdict.decision === 'allow') {
      const out = await execute(verdict, { trigger: 'auto', sessionId });
      cards.push({ event: 'demo.result', data: out });
    }
    const last = cards[cards.length - 1];
    const line = (action.say || '').trim();
    const note = receipt(last);
    // 被闸门拒绝时，模型写的那句「准备冲水」不成立，播报改成拒绝原因。
    const spoken = verdict.decision === 'deny' ? note : (line || note);
    return { cards, verdict, receipt: note, spoken };
  }

  function completeAction(action, userText) {
    const commands = scenario.commands;
    if (action.action === 'device.control') {
      return { ...action, targets: completeList(action.targets, userText, commands) };
    }
    if (action.action === 'scene.create') {
      return {
        ...action,
        conditionList: completeList(action.conditionList, userText, commands),
        actionList: completeList(action.actionList, userText, commands),
      };
    }
    return action;
  }

  function loadLive(load) {
    if (!load) return Promise.resolve({ rows: [] });
    let timer = 0;
    const pending = Promise.resolve().then(() => load(false)).finally(() => clearTimeout(timer));
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ rows: [], error: '设备列表超时' }), 4000);
    });
    return Promise.race([pending, timeout]);
  }

  const NAMED = /主卫|客卫|11楼|楼上|楼下|AKB|AQW|QN-|ACH/;

  async function chooseDevice(action, userText) {
    const lists = action.action === 'scene.create'
      ? [action.actionList]
      : action.action === 'device.control' ? [action.targets] : [];
    const known = (name) => trustedName(name, devices);
    // 原话没点名房间或型号时，模型猜的哪一台都不算数，一律按原话收窄。
    const unnamed = !NAMED.test(String(userText || ''));
    const needsPick = unnamed || lists.flat().some((item) => item && !known(item.deviceName));
    if (!needsPick) return { action };
    const live = await loadLive(liveDevices);
    const cmd = lists.flat().find((item) => item?.cmd)?.cmd || '';
    const choices = narrowDevices({ devices, live, userText, cmd });
    if (choices.length === 1) {
      const name = choices[0].deviceName;
      return {
        action: {
          ...action,
          targets: fillTargets(action.targets, name, devices),
          actionList: fillTargets(action.actionList, name, devices),
        },
      };
    }
    if (choices.length > 1) return { action, choices };
    return { action, none: true };
  }

  async function confirm({ sessionId, pendingId, decision }) {
    if (decision === 'cancel') {
      const rejected = gate.reject(pendingId);
      if (!rejected.ok) return { ok: false, error: rejected.error };
      await audit.append({
        kind: rejected.rec.action.action, actor: 'app-user', sessionId,
        level: rejected.rec.level, decision: 'REJECTED', pendingId, result: 'CANCELLED',
      });
      const spoken = '已取消，这一次没有下发。';
      return { ok: true, state: 'CANCELLED', spoken, receipt: spoken, cards: [{ event: 'demo.gate', data: { decision: 'cancel', pendingId, level: rejected.rec.level } }] };
    }
    const claimed = gate.claim(pendingId);
    if (!claimed.ok) return { ok: false, error: claimed.error };
    const out = await execute(claimed.rec, { trigger: 'confirm', sessionId });
    gate.settle(pendingId, out.ok ? 'SUCCEEDED' : 'FAILED');
    const card = { event: 'demo.result', data: out };
    const spoken = receipt(card);
    return { ok: true, state: out.result, spoken, receipt: spoken, cards: [card] };
  }

  return { finish, confirm, execute, chooseDevice };
}
