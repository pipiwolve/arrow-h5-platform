// 把物联网平台刚返回的设备和指令表收成一段事实。
// 人设在百度控制台。这段只在用户要操作设备时附在当轮 [T] 后面，给模型选设备。
// 它不是对用户说的话。模型若照抄，visibleReply 会从气泡里拿掉。

const CATEGORY = { '01': '马桶', '04': '浴缸', '06': '镜柜' };

export const ROSTER_MARK = '【家庭设备】';

export function buildRole({ scenario, devices, live }) {
  const lines = [
    `${ROSTER_MARK}下面是本轮可选设备。deviceName、cmd、param、value 只能从这段里逐字取。`,
    '- 用户开、关、冲水、进水、夜灯、翻盖、脚触、润瓷时，必须调用 control_device。不要用文字反问，不要只回「准备发给平台」而不调用。',
    '- 选设备按这个顺序：先按房间收窄（主卫、客卫、11楼）；再按品类或型号收窄（坐便器、马桶、浴缸、镜柜，或 AKB、AQW、QN 型号）；收窄后仍有多台，取这段清单里排在最前面的那一台。',
    '- 收窄后一台都没有，不要调用函数，正文说这一次没有对得上的设备。',
    '- deviceName 只能填设备号那一串（ARROW 开头），不要填昵称、型号或房间。不要把这段清单复述给用户。',
  ];
  const rows = Array.isArray(live?.rows) ? live.rows : [];
  if (!live?.ok) {
    lines.push(`设备列表这次没取到${live?.error ? `（${live.error}）` : ''}。不要编造设备，不要声称某台在线。`);
  } else if (!rows.length) {
    lines.push('平台返回 0 台设备。不要编造设备。');
  } else {
    for (const d of rows) {
      const known = devices.find((x) => x.deviceName === d.deviceName) || {};
      const room = known.room || '';
      const tag = d.deviceTagName || known.deviceTagName || '';
      const cat = CATEGORY[d.categoryCode || known.categoryCode] || '';
      const online = d.onlineStatus ? '在线' : '离线';
      const caps = Array.isArray(known.capability) ? known.capability.join(',') : '';
      lines.push(`- 设备号 ${d.deviceName}；${[room, tag, cat, online].filter(Boolean).join(' ')}；可执行 ${caps}`);
    }
    lines.push('离线设备也可以提交，正文写准备发给平台，不要写已经执行。');
  }
  lines.push('指令参数名都是 switch，取值逐字使用：');
  for (const c of scenario.commands) {
    const vals = Object.entries(c.params).map(([k, v]) => `${k}=${v.join('/')}`).join(' ');
    lines.push(`- ${c.cmd} ${vals} ${c.desc}`);
  }
  lines.push('开、关、冲水、进水、夜灯、翻盖、脚触、润瓷的句子，一律走 control_device。');
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
