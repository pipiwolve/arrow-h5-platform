// IoT 返回家庭目录；品类、软件支持的功能与设备消歧在业务层处理。
export const CATEGORIES = {
  '01': { name: '马桶', aliases: ['马桶', '坐便器', '智能坐便'] },
  '02': { name: '浴霸', aliases: ['浴霸', '暖风机'] },
  '04': { name: '浴缸', aliases: ['浴缸'] },
  '06': { name: '镜柜', aliases: ['镜柜'] },
};

const FEATURES = {
  warm_air: ['暖风', '暖风功能', 'warm_air', 'warmAir'],
  night_light: ['夜灯', '灯光', '照明', 'night_light', 'light'],
  watering: ['大冲', '冲水', 'watering', 'flush'],
  auto_closing: ['自动翻盖', '翻盖', 'auto_closing'],
  kicking: ['脚触感应', '脚触', 'kicking'],
  auto_oiling_porcelain: ['自动润瓷', '润瓷', 'auto_oiling_porcelain'],
  water_in: ['进水', '放水', 'water_in'],
  onoff: ['电源', '开关', 'onoff', 'power'],
};

export function categoryCode(value) {
  const text = String(value || '').trim();
  if (/^\d{1,2}$/.test(text)) return text.padStart(2, '0');
  return Object.entries(CATEGORIES).find(([, spec]) => spec.aliases.includes(text))?.[0] || text;
}

export function featureName(value) {
  const text = String(value || '').trim();
  return Object.entries(FEATURES).find(([, aliases]) => aliases.includes(text))?.[0] || text;
}

export function operationValue(value) {
  const text = String(value || '').trim().toLowerCase();
  if (['on', 'open', 'enable', 'start', '打开', '开启', '启动'].includes(text)) return 'on';
  if (['off', 'close', 'disable', 'stop', '关闭', '关掉', '停止'].includes(text)) return 'off';
  return text;
}

export function commandForFeature(feature, commands) {
  const name = featureName(feature);
  return commands.find((spec) => (spec.feature || spec.cmd.replace(/^switch_/, '')) === name);
}

export function catalogRows({ rows, devices, commands }) {
  const seen = new Set();
  return (rows || []).flatMap((row) => {
    if (!row?.deviceName || seen.has(row.deviceName)) return [];
    seen.add(row.deviceName);
    const known = devices.find((device) => device.deviceName === row.deviceName) || {};
    const code = categoryCode(row.categoryCode || known.categoryCode);
    // 接口未给能力时使用显式的软件适配表；这不代表硬件已验证执行。
    const supplied = row.capability ?? known.capability;
    const capability = Array.isArray(supplied) ? supplied
      : commands.filter((spec) => spec.appliesTo.includes(code)).map((spec) => spec.cmd);
    return [{
      deviceName: row.deviceName,
      deviceTagName: row.deviceTagName || known.deviceTagName || row.deviceName,
      categoryCode: code,
      category: CATEGORIES[code]?.name || '未适配品类',
      room: row.room ?? known.room ?? '',
      onlineStatus: Number(row.onlineStatus) === 1 ? 1 : 0,
      capability,
      capabilitySource: Array.isArray(supplied) ? 'device-profile' : 'category-adapter',
    }];
  });
}

export function summarizeCatalog(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.categoryCode)) groups.set(row.categoryCode, {
      categoryCode: row.categoryCode, category: row.category, count: 0, onlineCount: 0,
    });
    const group = groups.get(row.categoryCode);
    group.count += 1;
    group.onlineCount += row.onlineStatus;
  }
  return { totalCount: rows.length, categories: [...groups.values()] };
}

export function resolveControl(action, userText, commands) {
  // 云端已识别为控制后再检查明确的知识/状态语句；不拦截发给模型的原句。
  const text = String(userText || '').trim();
  const immediate = /^(?:请(?!问)|帮我|替我|给我|麻烦(?:你)?|(?:可以|能否|能不能|能|可否)(?:帮我|替我|给我)?)(?:把.{1,15}的?)?(?:打开|开启|关闭|关掉|启动|停用|停止|冲水|大冲|进水|放水)/.test(text);
  const informational = /(?:怎么|如何|怎样).{0,10}(?:打开|开启|关闭|关掉|使用|操作|启动)|(?:介绍|解释|说明).{0,12}(?:功能|暖风|夜灯|马桶|浴霸|镜柜)|(?:耗电|功率|原理|什么意思|有什么用|什么作用)|(?:是否|是不是|有没有|现在).{0,12}(?:开启|打开|开着|关闭|关着|运行)|(?:开着|关着|开了|关了|已开启|已关闭).{0,3}[吗么]/.test(text);
  if (informational && !immediate) throw new Error('这是使用方法、知识或状态询问，本次没有下发控制指令。');
  const target = action.targets?.[0] || {};
  if ((action.targets || []).length > 1) throw new Error('请一次选择一个设备，多个设备的控制需要分别确认。');
  const feature = featureName(action.feature || target.feature);
  const mapped = feature ? commandForFeature(feature, commands) : null;
  if (feature && !mapped) throw new Error('这个功能尚未适配，请先选择已支持的控制功能。');
  if (target.cmd && mapped && target.cmd !== mapped.cmd) throw new Error('识别出的功能与控制指令不一致，这一次没有下发。');
  const cmd = target.cmd || mapped?.cmd || '';
  const spec = commands.find((item) => item.cmd === cmd);
  if (!spec) throw new Error(cmd ? '这个控制功能尚未适配，这一次没有下发。' : '还没有明确要控制的功能，请补充具体功能。');
  const param = target.param || 'switch';
  const legacyValue = operationValue(target.value);
  const semanticValue = operationValue(action.operation || target.operation);
  if (legacyValue && semanticValue && legacyValue !== semanticValue) throw new Error('识别出的操作与控制值不一致，这一次没有下发。');
  const value = legacyValue || semanticValue;
  if (!spec.params[param]?.includes(value)) throw new Error('还没有明确或合法的操作，请说明要打开还是关闭。');
  const proposedCode = categoryCode(action.categoryCode || target.categoryCode);
  if (proposedCode && (!CATEGORIES[proposedCode] || !spec.appliesTo.includes(proposedCode))) throw new Error('该品类没有适配所请求的功能，这一次没有下发。');
  const mentionedCode = Object.entries(CATEGORIES).find(([, entry]) => entry.aliases.some((name) => text.includes(name)))?.[0] || '';
  // A shared feature such as night light does not identify a device category.
  // Ground the category in the original request or a single-category adapter;
  // an unmentioned category guessed by the model must not hide valid devices.
  const code = mentionedCode || (spec.appliesTo.length === 1 ? spec.appliesTo[0] : '');
  if (code && (!CATEGORIES[code] || !spec.appliesTo.includes(code))) throw new Error('该品类没有适配所请求的功能，这一次没有下发。');
  return {
    ...action, categoryCode: code, feature: feature || spec.feature || cmd.replace(/^switch_/, ''),
    targets: [{ ...target, deviceName: '', cmd, param, value }],
  };
}

export function controlCandidates(action, rows, userText) {
  const target = action.targets[0];
  const text = String(userText || '');
  // A model may copy a location from the roster. Only user-mentioned locations
  // may narrow candidates; otherwise a multi-device request must stay a choice.
  const proposedRoom = String(action.room || '').trim();
  const room = ['主卫', '客卫', ...rows.map((row) => row.room).filter(Boolean)].find((name) => text.includes(name))
    || (proposedRoom && text.includes(proposedRoom) ? proposedRoom : '');
  const proposedAlias = String(action.deviceAlias || '').trim();
  const alias = proposedAlias && text.includes(proposedAlias) ? proposedAlias : '';
  const named = rows.find((row) => text.includes(row.deviceName)
    || (row.deviceTagName.length > 2 && text.includes(row.deviceTagName)));
  return rows.filter((row) => {
    if (!CATEGORIES[row.categoryCode]) return false;
    if (action.categoryCode && row.categoryCode !== action.categoryCode) return false;
    if (!row.capability.includes(target.cmd)) return false;
    if (room && row.room !== room) return false;
    if (alias && ![row.deviceName, row.deviceTagName, row.room].some((name) => name && name.includes(alias))) return false;
    if (named && row.deviceName !== named.deviceName) return false;
    return true;
  });
}
