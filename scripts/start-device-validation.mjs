import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = ['single', 'real'].includes(process.argv[2]) ? process.argv[2] : 'multi';
const real = profile === 'real';
const state = fs.mkdtempSync(path.join(os.tmpdir(), `arrow-validation-${profile}-`));
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: root, stdio: 'inherit', env: {
    ...process.env, PORT: process.env.PORT || (real ? '8912' : '8910'), IOT_PORT: process.env.IOT_PORT || '18910',
    IOT_MODE: real ? 'real' : 'mock', DEVICE_ROUTE: 'cloud', STATE_DIR: state,
    ...(real ? { IOT_FIXTURE: 'real' } : {
      IOT_TOKEN: 'local-validation-token', IOT_FIXTURE_FILE: `config/fixtures/devices.validation-${profile}.json`,
    }),
  },
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code || 0));
