// 把物联网平台刚返回的设备和指令表收成一段事实。
// 人设在百度控制台。这段在进房时读取，为函数参数提供目录上下文。
// 它不是对用户说的话。模型若照抄，visibleReply 会从气泡里拿掉。

import { catalogRows } from './device-catalog.mjs';

export const ROSTER_MARK = '【家庭设备】';

export function buildRole({ scenario, devices, live }) {
  const lines = [
    `${ROSTER_MARK}这是家庭设备目录和软件适配表，仅作为上下文。实际可选设备由后端重新查询。`,
    '- 先区分用户是在问知识、查询状态，还是明确要求立即控制。介绍功能、询问如何使用、询问耗电、询问是否已经开启，均不调用控制函数。',
    '- 用户明确要求立即操作时调用 control_device，提取品类、功能、打开或关闭；定时要求走场景函数。含糊表达先澄清。',
    '- 未点名设备时不要自行选第一台。deviceName 可以留空；后端按品类、功能和位置筛选，多台时页面提供选择卡。',
    '- 若函数仍要求 deviceName 必填，只能使用目录中真实存在的设备号；后端会重新筛选，模型填的设备号不代表用户已选择。',
    '- 不编造设备、房间、功能或命令，不向用户索要接口字段；准备控制不代表平台已经执行。不要复述这段目录。',
  ];
  const rows = catalogRows({ rows: live?.rows, devices, commands: scenario.commands });
  if (!live?.ok) {
    lines.push(`设备列表这次没取到${live?.error ? `（${live.error}）` : ''}。不要编造设备，不要声称某台在线。`);
  } else if (!rows.length) {
    lines.push('平台返回 0 台设备。不要编造设备。');
  } else {
    for (const d of rows) {
      const room = d.room || '';
      const tag = d.deviceTagName;
      const cat = d.category;
      const online = d.onlineStatus ? '在线' : '离线';
      const caps = d.capability.join(',');
      lines.push(`- 设备号 ${d.deviceName}；品类编码 ${d.categoryCode}；${[room, tag, cat, online].filter(Boolean).join(' ')}；软件适配 ${caps}`);
    }
    lines.push('离线设备由后端停止下发并说明原因。');
  }
  lines.push('指令参数名都是 switch，取值逐字使用：');
  for (const c of scenario.commands) {
    const vals = Object.entries(c.params).map(([k, v]) => `${k}=${v.join('/')}`).join(' ');
    lines.push(`- ${c.cmd} ${vals} ${c.desc}`);
  }
  lines.push('知识问答直接回答；只有明确的执行要求才调用控制函数，后端返回结果后再反馈。');
  return lines.join('\n').slice(0, 6000);
}

/** 模型把附在 [T] 后的设备清单照抄进回答时，气泡里不留这段。与用户原话完全相同的复述也不留。 */
export function visibleReply(text, userText) {
  let src = String(text || '').trim();
  const at = src.indexOf(ROSTER_MARK);
  if (at >= 0) src = src.slice(0, at).trim();
  const asked = String(userText || '').replace(/\s+/g, '');
  if (asked && src.replace(/\s+/g, '') === asked) return '';
  return src;
}

/**
 * 房间把整段 [T] 以 [Q] 回放。回放里从清单标记起不是用户说的话。
 * 本地已经画过用户原话时，回放只用来对上这一条，不再追加。
 * @returns {{ text: string, echo: boolean }}
 */
export function userEcho(text, sentText) {
  let src = String(text || '').trim();
  const at = src.indexOf(ROSTER_MARK);
  if (at >= 0) src = src.slice(0, at).trim();
  const sent = String(sentText || '').trim();
  if (!sent) return { text: src, echo: false };
  const got = src.replace(/\s+/g, '');
  const want = sent.replace(/\s+/g, '');
  if (!got || !want) return { text: src, echo: false };
  if (got === want || want.startsWith(got)) return { text: src, echo: true };
  const extra = got.length - want.length;
  return { text: src, echo: extra > 0 && extra <= 3 && got.endsWith(want) };
}
