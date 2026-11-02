#!/usr/bin/env node
/**
 * Chạy toàn bộ hệ thống local: CMS + consumer B2B + consumer B2C (+ web).
 * Log được gắn tiền tố để nhìn ra ngay service nào đang nói.
 *
 *   pnpm dev          # 3 service backend
 *   pnpm dev --web    # thêm React storefront
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function loadEnv() {
  const file = path.join(root, '.env');
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => {
        const index = line.indexOf('=');
        return index === -1 ? [line, ''] : [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

const env = { ...process.env, ...loadEnv() };
const withWeb = process.argv.includes('--web');

const services = [
  { name: 'cms', args: ['apps/cms/dist/main.js'], color: 34 },
  { name: 'b2b', args: ['apps/consumer-b2b/dist/main.js'], color: 36 },
  { name: 'b2c', args: ['apps/consumer-b2c/dist/main.js'], color: 35 },
];

for (const service of services) {
  const entry = path.join(root, service.args[0]);
  if (!existsSync(entry)) {
    console.error(`Thiếu ${path.relative(root, entry)} — chạy: pnpm build`);
    process.exit(1);
  }
}

const children = [];

function start(name, command, args, color) {
  const child = spawn(command, args, {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // nhóm process riêng để Ctrl-C / huỷ task không để lại process mồ côi
    detached: true,
  });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream, target) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) target.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    console.log(prefix + `dừng (code ${code})`);
  });
  children.push(child);
  return child;
}

for (const service of services) {
  start(service.name, process.execPath, ['--env-file=.env', ...service.args], service.color);
}

if (withWeb) {
  start('web', 'pnpm', ['--filter', '@pubsub/web-b2c', 'dev'], 33);
}

const killTree = (child, signal) => {
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
};

const shutdown = () => {
  for (const child of children) killTree(child, 'SIGTERM');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => {
  for (const child of children) killTree(child, 'SIGKILL');
});

console.log('\nCMS      http://localhost:' + (env.CMS_PORT ?? 3001));
console.log('B2B      http://localhost:' + (env.CONSUMER_B2B_PORT ?? 3002) + '/mirror/state');
console.log('B2C      http://localhost:' + (env.CONSUMER_B2C_PORT ?? 3003) + '/mirror/state');
if (withWeb) console.log('Web      http://localhost:5173');
console.log('');
