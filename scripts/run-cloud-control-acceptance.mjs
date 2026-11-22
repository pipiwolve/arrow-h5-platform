import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { runCloudControlAcceptance } from './cloud-control-acceptance.mjs';

const options = JSON.parse(process.argv[2] || '{}');
if (options.suite) {
  const suites = JSON.parse(fs.readFileSync('config/fixtures/control-acceptance-cases.json', 'utf8'));
  options.cases = suites[options.suite].slice(options.from || 0, options.to ?? suites[options.suite].length);
}
const name = String(options.round || 'full').replace(/[^a-zA-Z0-9_-]/g, '_');
const evidenceDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong' }).format(new Date());
const output = `deployment-evidence/cloud-control-${name}-${evidenceDate}.json`;
if (fs.existsSync(output)) throw new Error(`Evidence already exists: ${output}; choose a new round name`);
options.capturePrefix = `${name}-${evidenceDate}`;
fs.mkdirSync('output/playwright', { recursive: true });
const script = `output/playwright/control-batch-${name}.js`;
fs.writeFileSync(script, `async page => (${runCloudControlAcceptance.toString()})(page, ${JSON.stringify(options)})\n`);
const wrapper = path.join(os.homedir(), '.codex/skills/playwright/scripts/playwright_cli.sh');
const child = spawn('rtk', ['proxy', wrapper, `-s=${options.session || 'arrow-cloud-validation'}`, 'run-code', '--filename', script], { stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });
child.on('close', (code) => {
  const match = stdout.match(/### Result\r?\n([\s\S]*?)(?:\r?\n### |$)/);
  if (!match) {
    // SDK debug output may include credentials; only print the CLI error headline.
    console.error((stdout.match(/### Error\r?\n([^\n]+)/)?.[1] || stderr.split('\n').find((line) => line.includes('Error')) || `No browser result (exit ${code})`).slice(0, 250));
    process.exitCode = 1;
    return;
  }
  const result = JSON.parse(match[1].trim());
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ output, total: result.total, passed: result.passed,
    results: result.results.map((x) => ({ id: x.id, query: x.query, pass: x.pass, failures: x.failures,
      calls: x.pass ? undefined : x.calls, answers: x.pass ? undefined : x.answers,
      command: x.result?.cmdList?.map((c) => `${c.cmd}/${c.param}/${c.value}`), count: x.candidateCount })) }, null, 2));
  process.exitCode = code || 0;
});
