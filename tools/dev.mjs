// Runs the signalling server (FastAPI) and the game's Vite server together; Ctrl+C stops both.
import { spawn } from 'node:child_process';

const children = [
  ['signal', 'npm run dev:signal'],
  ['game', 'npm run dev:game'],
].map(([name, command]) => {
  const child = spawn(command, { stdio: 'inherit', shell: true });
  child.on('exit', (code) => {
    console.log(`[${name}] exited${code === null ? '' : ` with code ${code}`}`);
    stop(code ?? 1);
  });
  return child;
});

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) kill(child);
  process.exitCode = code;
}

// Each child is a shell running npm running the server. On Windows killing the shell
// leaves the server orphaned, so the whole process tree goes.
function kill(child) {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill();
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
