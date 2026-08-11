/**
 * Dev runner: starts the Vite dev server, waits for it, then launches
 * Electron pointed at http://localhost:3000 with HMR enabled.
 *
 * Usage: npm run electron:dev
 * Stop with Ctrl+C — both processes are killed.
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const VITE_URL = 'http://localhost:3000';
const WAIT_TIMEOUT_MS = 60000;

const isWin = process.platform === 'win32';
const viteCmd = isWin ? 'npx.cmd' : 'npx';
const electronBin = require('electron'); // resolves to the electron executable path

let electron = null;
let shuttingDown = false;

function waitForVite() {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(VITE_URL, () => resolve());
      req.on('error', () => {
        if (Date.now() - started > WAIT_TIMEOUT_MS) {
          reject(new Error(`Vite did not come up within ${WAIT_TIMEOUT_MS / 1000}s`));
        } else {
          setTimeout(attempt, 400);
        }
      });
      req.end();
    };
    attempt();
  });
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (electron && !electron.killed) electron.kill();
  vite.kill();
  // give children a moment to exit, then bail out regardless
  setTimeout(() => process.exit(code), 500).unref();
}

const vite = spawn(viteCmd, ['vite'], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
});

vite.on('exit', (code) => {
  if (!shuttingDown) {
    console.error(`\n[electron:dev] Vite exited with code ${code}`);
    shutdown(code ?? 1);
  }
});

(async () => {
  try {
    await waitForVite();
  } catch (e) {
    console.error(`\n[electron:dev] ${e.message}`);
    shutdown(1);
    return;
  }

  electron = spawn(electronBin, ['.'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    env: { ...process.env, LUMINA_URL: VITE_URL },
  });

  electron.on('exit', (code) => shutdown(code ?? 0));
})();

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
