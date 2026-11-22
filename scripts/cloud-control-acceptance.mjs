// Real BRTC browser acceptance against an isolated mock IoT service.
// This function is embedded in playwright-cli run-code; no cloud frames are injected.
export async function runCloudControlAcceptance(page, options = {}) {
  const matrix = [
    ['heater-on', '打开浴霸暖风', '02', 'switch_warm_air', 'on', 2],
    ['heater-off', '关闭浴霸暖风', '02', 'switch_warm_air', 'off', 2],
    ['toilet-flush', '打开马桶冲水', '01', 'switch_watering', 'on', 6],
    ['toilet-light-on', '打开马桶夜灯', '01', 'switch_night_light', 'on', 6],
    ['toilet-light-off', '关闭马桶夜灯', '01', 'switch_night_light', 'off', 6],
    ['mirror-light-on', '打开镜柜夜灯', '06', 'switch_night_light', 'on', 3],
    ['mirror-light-off', '关闭镜柜夜灯', '06', 'switch_night_light', 'off', 3],
    ['lid-on', '打开马桶自动翻盖', '01', 'switch_auto_closing', 'on', 6],
    ['lid-off', '关闭马桶自动翻盖', '01', 'switch_auto_closing', 'off', 6],
    ['kick-on', '打开马桶脚触感应', '01', 'switch_kicking', 'on', 6],
    ['kick-off', '关闭马桶脚触感应', '01', 'switch_kicking', 'off', 6],
    ['porcelain-on', '打开马桶润瓷', '01', 'switch_auto_oiling_porcelain', 'on', 6],
    ['porcelain-off', '关闭马桶润瓷', '01', 'switch_auto_oiling_porcelain', 'off', 6],
    ['toilet-power-on', '打开马桶电源', '01', 'switch_onoff', 'on', 6],
    ['toilet-power-off', '关闭马桶电源', '01', 'switch_onoff', 'off', 6],
    ['bath-power-on', '打开浴缸电源', '04', 'switch_onoff', 'on', 2],
    ['bath-power-off', '关闭浴缸电源', '04', 'switch_onoff', 'off', 2],
    ['mirror-power-on', '打开镜柜电源', '06', 'switch_onoff', 'on', 3],
    ['mirror-power-off', '关闭镜柜电源', '06', 'switch_onoff', 'off', 3],
    ['bath-fill-on', '打开浴缸进水', '04', 'switch_water_in', 'on', 2],
    ['bath-fill-off', '关闭浴缸进水', '04', 'switch_water_in', 'off', 2],
  ].map(([id, query, categoryCode, cmd, value, count]) => ({ id, query, categoryCode, cmd, param: 'switch', value, count }));
  const selected = options.cases || matrix.slice(options.from || 0, options.to ?? matrix.length);
  const evidence = { round: options.round || 'full', startedAt: new Date().toISOString(), agent: 'real BRTC', iot: 'local mock',
    protocol: { queryPerCase: 1, recognitionTimeoutMs: 25000, preparationTimeoutMs: 12000, negativeFinalAnswerGraceMs: 4000 }, results: [] };
  await page.addInitScript(() => {
    // run-code batches reuse a page; install one recorder per new document.
    if (window.__arrowAcceptance) return;
    const capture = window.__arrowAcceptance = { sent: [], incoming: [], exchanges: [] };
    const decode = (frame) => {
      if (typeof frame !== 'string') return null;
      if (frame.startsWith('[F]:')) {
        try {
          const outer = JSON.parse(frame.slice(4));
          const content = typeof outer.content === 'string' ? JSON.parse(outer.content) : outer.content;
          if (!content) return null;
          const name = content.function_name || content.name;
          if (!name) return { kind: 'function-result' };
          return { kind: 'function', name, params: content.parameter_list || content.parameters,
            shape: { outerKeys: Object.keys(outer), contentKeys: Object.keys(content) },
            query: String(outer.query || content.query || '').split('【家庭设备】')[0].trim() };
        } catch { return { kind: 'malformed-function' }; }
      }
      if (frame.startsWith('[A]:') && !frame.includes('[M]')) return { kind: 'answer', text: frame.slice(4).replace(/^\[C\]:?/, '').trim() };
      return null;
    };
    let start;
    Object.defineProperty(window, 'BRTC_Start', {
      configurable: true,
      get: () => start ? function (settings) {
        const callback = settings.onmessage;
        settings.onmessage = function (message) {
          const safe = decode(String(message?.data || ''));
          if (safe) capture.incoming.push({ at: Date.now(), ...safe });
          return callback?.apply(this, arguments);
        };
        return start.apply(this, arguments);
      } : undefined,
      set: (value) => { start = value; },
    });
    let send;
    Object.defineProperty(window, 'BRTC_SendMessageToUser', {
      configurable: true,
      get: () => send ? function (frame) {
        if (typeof frame === 'string' && frame.startsWith('[T]:')) capture.sent.push({ kind: 'query', text: frame.slice(4).split('【家庭设备】')[0].trim() });
        if (typeof frame === 'string' && frame.startsWith('[TTS]:')) capture.sent.push({ kind: 'speech', text: frame.slice(6) });
        if (typeof frame === 'string' && frame.startsWith('[F]:')) capture.sent.push({ kind: 'function-result' });
        return send.apply(this, arguments);
      } : undefined,
      set: (value) => { send = value; },
    });
    const originalFetch = window.fetch;
    window.fetch = async function (input, init) {
      const response = await originalFetch.apply(this, arguments);
      const path = String(input);
      if (['/api/frame', '/api/choose', '/api/confirm'].includes(path)) {
        const request = init?.body ? JSON.parse(init.body) : {};
        const body = await response.clone().json().catch(() => ({}));
        const result = body.cards?.find((card) => card.event === 'demo.result')?.data;
        const choice = body.cards?.find((card) => card.event === 'demo.choose')?.data;
        const gate = body.cards?.find((card) => card.event === 'demo.gate')?.data;
        capture.exchanges.push({ at: Date.now(), path, status: response.status,
          request: { userText: request.userText, frame: decode(request.frame), requestId: request.requestId, deviceName: request.deviceName,
            pendingId: request.pendingId, decision: request.decision, keys: Object.keys(request) },
          response: { state: body.state, parsed: body.parsed, spoken: body.spoken || body.receipt,
            error: body.error, requestId: body.requestId, catalog: body.catalog,
            choice: choice ? { requestId: choice.requestId, count: choice.count, categoryCode: choice.categoryCode, choices: choice.choices } : null,
            gate: gate ? { decision: gate.decision, pendingId: gate.pendingId, reasons: gate.reasons } : null,
            result: result ? { state: result.result, httpStatus: result.httpStatus, ok: result.ok, cmdList: result.iotRequest?.body?.cmdList,
              homeId: result.iotRequest?.body?.homeId, platform: result.iotResponse, error: result.error } : null } });
      }
      return response;
    };
  });
  for (const test of selected) {
    const record = { ...test, startedAt: new Date().toISOString(), pass: false, failures: [] };
    try {
      record.stage = 'connect';
      for (let attempt = 1; attempt <= 2; attempt++) {
        record.connectionAttempts = attempt;
        try {
          // Finish our previous call before navigation so pagehide cannot cancel
          // the asynchronous stop request and leave a cloud instance running.
          if (/^http:\/\/127\.0\.0\.1:891[0145]\//.test(page.url())) {
            await page.evaluate(async () => { if (typeof stopCall === 'function') await stopCall(); });
          }
          await page.goto(options.url || 'http://127.0.0.1:8910');
          await page.waitForFunction(() => document.getElementById('status')?.textContent === '已连接', undefined, { timeout: 25000 });
          await page.waitForFunction(() => !document.getElementById('textInput')?.disabled, undefined, { timeout: 10000 });
          break;
        } catch (error) {
          (record.connectionErrors ||= []).push(String(error.message || error).split('\n')[0]);
          if (attempt === 2) throw error;
        }
      }
      const config = await page.evaluate(async () => { const c = await (await fetch('/api/config')).json(); return { iotMode: c.iotMode, homeId: c.homeId, route: c.deviceRoute }; });
      if (config.iotMode !== 'mock') throw new Error('Acceptance requires mock IoT; refused real hardware dispatch');
      if (config.route !== 'cloud') throw new Error('Acceptance requires cloud intent routing');
      record.environment = config;
      await page.evaluate(() => {
        window.__arrowAcceptance.sent.length = 0;
        window.__arrowAcceptance.incoming.length = 0;
        window.__arrowAcceptance.exchanges.length = 0;
      });
      record.stage = 'recognize';
      await page.getByRole('textbox', { name: '发给智能体的文字' }).fill(test.query);
      const sentAt = Date.now();
      record.sentAt = new Date(sentAt).toISOString();
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.waitForFunction(() => window.__arrowAcceptance.incoming.some((x) => x.kind === 'function')
        || window.__arrowAcceptance.exchanges.some((x) => x.path === '/api/frame' &&
          x.request.frame?.kind === 'answer' && x.request.frame.text.trim() && !/^你好，我是箭牌智家助手/.test(x.request.frame.text)), undefined, { timeout: 25000 });
      // A spoken answer is not evidence of a control call. Give positive cases
      // the full recognition window if the agent answers before calling.
      if (test.noDispatch) {
        await page.waitForTimeout(4000);
      } else {
        await page.waitForFunction(() => window.__arrowAcceptance.incoming.some((x) => x.kind === 'function'),
          undefined, { timeout: Math.max(1, 25000 - (Date.now() - sentAt)) }).catch(() => {});
        await page.waitForTimeout(400);
      }
      if (await page.evaluate(() => window.__arrowAcceptance.incoming.some((x) => x.kind === 'function'))) {
        record.stage = 'prepare';
        await page.waitForFunction(() => window.__arrowAcceptance.exchanges.some((x) => x.request.frame?.kind === 'function'),
          undefined, { timeout: 12000 });
      }
      let prepared = await page.evaluate(() => window.__arrowAcceptance.exchanges.find((x) => x.request.frame?.kind === 'function')?.response);
      record.selectionCardShown = Boolean(prepared?.choice);
      if (!test.noDispatch && (test.requireCard || test.count > 1) && !prepared?.choice) record.failures.push('missing-device-card');
      if (prepared?.catalog) {
        record.candidateCount = prepared.catalog.candidateCount;
        if (test.count !== undefined && test.count !== null && prepared.catalog.candidateCount !== test.count) record.failures.push('wrong-candidate-count');
      }
      if (prepared?.choice) {
        record.dispatchesBeforeSelection = await page.evaluate(() => window.__arrowAcceptance.exchanges.filter((x) => x.response.result?.cmdList).length);
        if (record.dispatchesBeforeSelection !== 0) record.failures.push('dispatch-before-selection');
        record.candidateCount = prepared.choice.count;
        record.candidateCategories = [...new Set(prepared.choice.choices.map((d) => d.categoryCode))];
        if (test.count !== undefined && test.count !== null && prepared.choice.count !== test.count) record.failures.push('wrong-candidate-count');
        const allowedCategories = test.categories || (test.categoryCode ? [test.categoryCode] : []);
        if (allowedCategories.length && prepared.choice.choices.some((d) => !allowedCategories.includes(d.categoryCode))) record.failures.push('wrong-candidate-category');
        if (!test.noDispatch) {
          record.stage = 'select';
          record.chosenDevice = prepared.choice.choices[0]?.deviceName;
          await page.locator(`[data-request-id="${prepared.choice.requestId}"]`).getByRole('button').first().click();
          await page.waitForFunction((id) => window.__arrowAcceptance.exchanges.some((x) => x.path === '/api/choose' && x.request.requestId === id), prepared.choice.requestId, { timeout: 12000 });
        }
      } else if (!test.noDispatch && !prepared?.result) {
        record.failures.push(prepared ? 'function-rejected-or-incomplete' : 'no-function-call');
      }
      const beforeConfirm = await page.evaluate(() => window.__arrowAcceptance.exchanges.at(-1)?.response);
      if (!test.noDispatch && beforeConfirm?.gate?.decision === 'confirm') {
        record.stage = 'confirm';
        record.confirmationRequired = true;
        record.dispatchesBeforeConfirmation = await page.evaluate(() => window.__arrowAcceptance.exchanges.filter((x) => x.response.result?.cmdList).length);
        if (record.dispatchesBeforeConfirmation !== 0) record.failures.push('dispatch-before-confirmation');
        await page.getByRole('button', { name: '确认执行', exact: true }).last().click();
        await page.waitForFunction((id) => window.__arrowAcceptance.exchanges.some((x) => x.path === '/api/confirm' && x.request.pendingId === id), beforeConfirm.gate.pendingId, { timeout: 12000 });
      }
      await page.waitForTimeout(400);
      const capture = await page.evaluate(() => window.__arrowAcceptance);
      record.stage = 'verify';
      record.capture = capture;
      record.queryCount = capture.sent.filter((x) => x.kind === 'query').length;
      record.calls = capture.incoming.filter((x) => x.kind === 'function');
      record.answers = capture.incoming.filter((x) => x.kind === 'answer').map((x) => x.text);
      const results = capture.exchanges.filter((x) => x.response.result?.cmdList).map((x) => x.response.result);
      record.dispatchCount = results.length;
      record.result = results.at(-1) || null;
      if (record.queryCount !== 1) record.failures.push('query-not-once');
      if (test.noDispatch) {
        if (results.length) record.failures.push('unexpected-dispatch');
        if (prepared?.choice) record.failures.push('unexpected-device-card');
        if (!record.answers.some((text) => text.trim()) && !capture.exchanges.some((x) => x.response.spoken)) record.failures.push('no-feedback');
      } else {
        if (results.length !== 1) record.failures.push('dispatch-not-once');
        const result = record.result;
        if (!result || result.state !== 'SUCCEEDED' || result.httpStatus !== 200 || result.platform?.success !== true) record.failures.push('platform-not-accepted');
        const actual = result?.cmdList?.[0];
        if (result?.cmdList?.length !== 1 || actual?.cmd !== test.cmd || actual?.param !== test.param || actual?.value !== test.value) record.failures.push('wrong-command');
        if (test.cmd === 'switch_water_in' && !record.confirmationRequired) record.failures.push('missing-high-risk-confirmation');
      }
      if (capture.exchanges.some((x) => x.path === '/api/choose' && (x.request.keys.includes('action') || x.request.keys.includes('userText')))) record.failures.push('page-supplied-control-action');
      record.pass = record.failures.length === 0;
      record.stage = 'complete';
      if (!record.pass || options.screenshots) {
        const screenshot = `output/playwright/control-${options.capturePrefix || options.round || 'full'}-${test.id}.png`;
        await page.screenshot({ path: screenshot, fullPage: true });
        record.screenshot = screenshot;
      }
    } catch (error) {
      record.failures.push(String(error.message || error).split('\n')[0]);
      record.capture = await page.evaluate(() => window.__arrowAcceptance).catch(() => null);
      if (record.capture) {
        record.queryCount = record.capture.sent.filter((x) => x.kind === 'query').length;
        record.calls = record.capture.incoming.filter((x) => x.kind === 'function');
        record.answers = record.capture.incoming.filter((x) => x.kind === 'answer').map((x) => x.text);
        const results = record.capture.exchanges.filter((x) => x.response.result?.cmdList).map((x) => x.response.result);
        record.dispatchCount = results.length;
        record.result = results.at(-1) || null;
      }
      const screenshot = `output/playwright/control-${options.capturePrefix || options.round || 'full'}-${test.id}.png`;
      await page.screenshot({ path: screenshot, fullPage: true }).then(() => { record.screenshot = screenshot; }).catch(() => {});
    }
    if (!options.keepFinalCall || test !== selected.at(-1)) {
      await page.evaluate(async () => { if (typeof stopCall === 'function') await stopCall(); }).catch(() => {});
    }
    evidence.results.push(record);
  }
  evidence.finishedAt = new Date().toISOString();
  evidence.total = evidence.results.length;
  evidence.passed = evidence.results.filter((x) => x.pass).length;
  return evidence;
}
