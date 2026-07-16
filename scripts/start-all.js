'use strict';
// Runs Plan A (3210) and Pacta (3220) side by side with prefixed logs.
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const procs = [
  { name: 'plan-a', file: 'server.js' },
  { name: 'pacta', file: 'server-pacta.js' },
].map(({ name, file }) => {
  const p = spawn(process.execPath, [path.join(root, file)], { cwd: root });
  const pipe = (stream, out) => stream.on('data', (d) => {
    for (const line of d.toString().split('\n')) if (line.trim()) out.write(`[${name}] ${line}\n`);
  });
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on('exit', (code) => {
    console.log(`[${name}] exited (${code})`);
    for (const other of procs) if (other !== p && other.exitCode === null) other.kill();
    process.exitCode = code || 0;
  });
  return p;
});

process.on('SIGINT', () => procs.forEach((p) => p.kill('SIGINT')));
process.on('SIGTERM', () => procs.forEach((p) => p.kill('SIGTERM')));
