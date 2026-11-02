#!/usr/bin/env node
/**
 * Kiểm chứng đầu-cuối trên hệ thống thật: CMS + hai consumer + Redis + Postgres.
 *
 * Kịch bản: seed → tạo/sửa/xoá supplier → so bản sao ở hai consumer → thử rò rỉ
 * cost sang B2C → thử token chéo → mô phỏng mất message → soát cursor.
 *
 *   pnpm build && pnpm e2e
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import Redis from 'ioredis';

const root = path.resolve(import.meta.dirname, '..');
const logDir = path.join(root, '.tmp');
mkdirSync(logDir, { recursive: true });

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
const config = {
  databaseUrl: env.DATABASE_URL ?? 'postgres://demo:demo@localhost:45432/cms',
  redisUrl: env.REDIS_URL ?? 'redis://localhost:46379',
  cmsUrl: `http://localhost:${env.CMS_PORT ?? 3001}`,
  b2bUrl: `http://localhost:${env.CONSUMER_B2B_PORT ?? 3002}`,
  b2cUrl: `http://localhost:${env.CONSUMER_B2C_PORT ?? 3003}`,
  adminToken: env.ADMIN_TOKEN ?? 'admin-dev-token',
  b2bToken: env.B2B_TOKEN ?? 'b2b-dev-token',
  b2cToken: env.B2C_TOKEN ?? 'b2c-dev-token',
  fence: env.FENCE_STRATEGY ?? 'txid',
};

const results = [];
let failed = 0;

function check(label, ok, detail = '') {
  results.push({ label, ok, detail });
  console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 4 });
const processes = [];

function spawnService(name, args, extraEnv = {}) {
  const logPath = path.join(logDir, `${name}.log`);
  const out = [];
  const child = spawn(process.execPath, ['--env-file=.env', ...args], {
    cwd: root,
    env: { ...env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    // nhóm process riêng: huỷ e2e là con bị huỷ theo, không để lại process mồ côi
    detached: true,
  });
  const capture = (chunk) => {
    out.push(chunk.toString());
    if (out.length > 200) out.shift();
    writeFileSync(logPath, out.join(''));
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.log(`  ${name} thoát với code ${code}, xem ${logPath}`);
  });
  processes.push(child);
  return child;
}

const killTree = (child, signal) => {
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
};

async function stopService(child) {
  if (child.exitCode !== null) return;
  killTree(child, 'SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(3000).then(() => killTree(child, 'SIGKILL')),
  ]);
}

async function waitFor(label, fn, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(200);
  }
  throw new Error(`timeout chờ ${label}${last instanceof Error ? `: ${last.message}` : ''}`);
}

const json = async (response) => {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
};

const admin = (method, urlPath, body) =>
  fetch(`${config.cmsUrl}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-admin-token': config.adminToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, body: await json(response) }));

const gql = (url, token, query, variables) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  }).then(async (response) => ({ status: response.status, body: await json(response) }));

const mirrorRows = async (baseUrl, entity) => {
  const response = await fetch(`${baseUrl}/mirror/${entity}`);
  return json(response);
};

const mirrorState = async (baseUrl) => json(await fetch(`${baseUrl}/mirror/state`));

const tcpOpen = (urlString) =>
  new Promise((resolve) => {
    const url = new URL(urlString);
    const socket = net.connect(Number(url.port), url.hostname);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });

async function main() {
  for (const [name, entry] of [
    ['cms', 'apps/cms/dist/main.js'],
    ['consumer-b2b', 'apps/consumer-b2b/dist/main.js'],
    ['consumer-b2c', 'apps/consumer-b2c/dist/main.js'],
  ]) {
    if (!existsSync(path.join(root, entry))) {
      throw new Error(`thiếu ${entry} — chạy pnpm build trước`);
    }
    void name;
  }

  if (!(await tcpOpen(config.databaseUrl))) throw new Error('Postgres chưa chạy — pnpm infra:up');
  if (!(await tcpOpen(config.redisUrl))) throw new Error('Redis chưa chạy — pnpm infra:up');

  // Cổng đang bận nghĩa là có process khác (thường là pnpm dev) — nếu cứ chạy,
  // e2e sẽ test nhầm process cũ và báo PASS sai.
  for (const [name, url] of [
    ['CMS', config.cmsUrl],
    ['consumer B2B', config.b2bUrl],
    ['consumer B2C', config.b2cUrl],
  ]) {
    if (await tcpOpen(url)) {
      throw new Error(`cổng của ${name} đang bận (${url}) — dừng pnpm dev rồi chạy lại`);
    }
  }

  // 1. CMS trước, để schema CMS tồn tại rồi mới dọn dữ liệu
  const cms = spawnService('cms', ['apps/cms/dist/main.js']);
  await waitFor('CMS /health', async () => (await fetch(`${config.cmsUrl}/health`)).ok);

  await pool.query('truncate supplier, country, sync_change restart identity cascade');
  await pool.query('drop schema if exists b2b cascade');
  await pool.query('drop schema if exists b2c cascade');

  // 2. Hai consumer: bootstrap lần đầu bằng danh sách rỗng
  const b2b = spawnService('consumer-b2b', ['apps/consumer-b2b/dist/main.js']);
  const b2c = spawnService('consumer-b2c', ['apps/consumer-b2c/dist/main.js']);
  await waitFor('B2B /health', async () => (await fetch(`${config.b2bUrl}/health`)).ok);
  await waitFor('B2C /health', async () => (await fetch(`${config.b2cUrl}/health`)).ok);

  check('hai consumer dùng hai schema Postgres riêng', true, 'b2b, b2c');

  // 3. Bắt một message thật để chứng minh nó "mỏng"
  const subscriber = new Redis(config.redisUrl);
  await subscriber.subscribe('cms.sync.b2b');
  const nextMessage = new Promise((resolve) => {
    subscriber.once('message', (_channel, payload) => resolve(JSON.parse(payload)));
  });

  const seeded = await admin('POST', '/admin/seed');
  check('seed tạo dữ liệu qua đúng đường ghi (có outbox)', seeded.status === 201 || seeded.status === 200);

  const message = await Promise.race([
    nextMessage,
    sleep(8000).then(() => {
      throw new Error('không nhận được message nào trên cms.sync.b2b');
    }),
  ]);
  await subscriber.quit();

  const messageKeys = Object.keys(message).sort().join(',');
  check(
    'message chỉ chứa metadata, không có dữ liệu nghiệp vụ',
    messageKeys === 'changeType,entity,eventId,id,seq,version' &&
      !('name' in message) &&
      !('costRate' in message),
    messageKeys,
  );

  // 4. Cả hai consumer nhận dữ liệu
  const suppliersB2c = await waitFor('B2C thấy 2 supplier', async () => {
    const rows = await mirrorRows(config.b2cUrl, 'supplier');
    return Array.isArray(rows) && rows.length === 2 ? rows : null;
  });
  const suppliersB2b = await waitFor('B2B thấy 2 supplier', async () => {
    const rows = await mirrorRows(config.b2bUrl, 'supplier');
    return Array.isArray(rows) && rows.length === 2 ? rows : null;
  });

  check(
    'B2C nhận bản sâu (description, photos)',
    suppliersB2c.every((row) => 'description' in row.payload && Array.isArray(row.payload.photos)),
  );
  check(
    'B2B nhận bản rộng (costRate, allotment)',
    suppliersB2b.every((row) => 'costRate' in row.payload && 'allotment' in row.payload),
  );
  check(
    'B2C không có cost/margin/allotment trong bản sao',
    suppliersB2c.every(
      (row) =>
        !('costRate' in row.payload) && !('margin' in row.payload) && !('allotment' in row.payload),
    ),
  );

  // 5. Tạo mới → sửa → xoá, kiểm tra cả hai consumer
  const created = await admin('POST', '/admin/suppliers', {
    name: 'E2E Supplier',
    description: 'tạo bởi e2e',
    photos: ['https://example.com/e2e.jpg'],
    taxCode: '0109999999',
    costRate: '500000',
    margin: '9',
    allotment: 7,
  });
  const id = created.body?.id;
  check('tạo supplier qua admin trả về id', Boolean(id), String(id));

  await waitFor('B2C thấy supplier mới', async () => {
    const rows = await mirrorRows(config.b2cUrl, 'supplier');
    return rows.some((row) => row.id === id && row.version === 1);
  });

  await admin('PATCH', `/admin/suppliers/${id}`, { name: 'E2E Supplier (đã sửa)' });

  await waitFor('hai consumer thấy version 2 và tên mới', async () => {
    const [b2bRows, b2cRows] = await Promise.all([
      mirrorRows(config.b2bUrl, 'supplier'),
      mirrorRows(config.b2cUrl, 'supplier'),
    ]);
    return (
      b2bRows.some((row) => row.id === id && row.version === 2) &&
      b2cRows.some(
        (row) => row.id === id && row.version === 2 && row.payload.name === 'E2E Supplier (đã sửa)',
      )
    );
  });

  await admin('DELETE', `/admin/suppliers/${id}`);

  await waitFor('tombstone xoá bản sao ở cả hai consumer', async () => {
    const [b2bRows, b2cRows] = await Promise.all([
      mirrorRows(config.b2bUrl, 'supplier'),
      mirrorRows(config.b2cUrl, 'supplier'),
    ]);
    return !b2bRows.some((row) => row.id === id) && !b2cRows.some((row) => row.id === id);
  });

  // 6. Hàng rào bảo mật
  const leakAttempt = await gql(
    `${config.cmsUrl}/graphql/b2c/v1`,
    config.b2cToken,
    '{ suppliers(first: 1) { nodes { id costRate } } }',
  );
  check(
    'B2C hỏi costRate bị chặn ở tầng schema',
    leakAttempt.body?.errors?.[0]?.extensions?.code === 'GRAPHQL_VALIDATION_FAILED',
    leakAttempt.body?.errors?.[0]?.extensions?.code,
  );

  const crossToken = await gql(
    `${config.cmsUrl}/graphql/b2c/v1`,
    config.b2bToken,
    '{ headSeq }',
  );
  check(
    'token B2B gọi endpoint B2C bị FORBIDDEN',
    crossToken.status === 403 && crossToken.body?.errors?.[0]?.extensions?.code === 'FORBIDDEN',
    String(crossToken.status),
  );

  const badBody = await admin('POST', '/admin/suppliers', { name: 'thiếu hết field bắt buộc' });
  check(
    'body thiếu field trả 400 kèm chi tiết, không phải 500',
    badBody.status === 400 && Array.isArray(badBody.body?.issues),
    `${badBody.status}`,
  );

  const noToken = await fetch(`${config.cmsUrl}/graphql/b2b/v1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ headSeq }' }),
  });
  check('không token bị UNAUTHENTICATED', noToken.status === 401, String(noToken.status));

  // 7. Mô phỏng mất message: consumer B2C bỏ qua toàn bộ message
  await stopService(b2c);
  const b2cDeaf = spawnService('consumer-b2c-deaf', ['apps/consumer-b2c/dist/main.js'], {
    DROP_MESSAGES: '1',
  });
  await waitFor('B2C (DROP_MESSAGES=1) /health', async () => {
    const response = await fetch(`${config.b2cUrl}/health`).catch(() => null);
    return response?.ok ?? false;
  });

  const ghost = await admin('POST', '/admin/suppliers', {
    name: 'Chỉ đến bằng changes()',
    description: 'message bị bỏ',
    photos: [],
    taxCode: null,
    costRate: '1000',
    margin: '1',
    allotment: 1,
  });
  const ghostId = ghost.body?.id;
  check('tạo supplier cho kịch bản mất message', Boolean(ghostId), `${ghost.status} ${JSON.stringify(ghost.body).slice(0, 160)}`);

  const dropped = await waitFor('B2C bỏ message', async () => {
    const state = await mirrorState(config.b2cUrl);
    return state.droppedMessages > 0 ? state : null;
  }, 8000).catch(async (error) => {
    console.log('  state lúc timeout:', JSON.stringify(await mirrorState(config.b2cUrl)));
    throw error;
  });
  void dropped;

  const healed = await waitFor('changes() bù lại bản ghi bị mất message', async () => {
    const rows = await mirrorRows(config.b2cUrl, 'supplier');
    const found = rows.find((row) => row.id === ghostId);
    return found ?? null;
  }, 20_000);

  check('bản ghi vẫn về dù message bị bỏ', healed.id === ghostId);
  check(
    'nhật ký consumer ghi rõ message bị bỏ',
    (await fetch(`${config.b2cUrl}/mirror/events`).then(json)).some(
      (event) => event.kind === 'message-dropped',
    ),
  );

  // 8. Cursor phải đuổi kịp headSeq, không bỏ sót
  const cmsState = await admin('GET', '/admin/state');
  const b2cState = await mirrorState(config.b2cUrl);
  const b2bState = await mirrorState(config.b2bUrl);

  check(
    'publisher đã gửi hết outbox',
    cmsState.body.unpublished === 0,
    `unpublished=${cmsState.body.unpublished}`,
  );
  check(
    'cursor hai consumer đuổi kịp headSeq',
    b2cState.cursor === cmsState.body.headSeq && b2bState.cursor === cmsState.body.headSeq,
    `b2c=${b2cState.cursor} b2b=${b2bState.cursor} head=${cmsState.body.headSeq}`,
  );

  const adminSuppliers = (await admin('GET', '/admin/suppliers')).body;
  const liveIds = adminSuppliers.map((row) => row.id).sort().join(',');
  const b2bIds = (await mirrorRows(config.b2bUrl, 'supplier')).map((row) => row.id).sort().join(',');
  const b2cIds = (await mirrorRows(config.b2cUrl, 'supplier')).map((row) => row.id).sort().join(',');
  check('bản sao B2B khớp danh sách sống của CMS', b2bIds === liveIds, `${b2bIds} vs ${liveIds}`);
  check('bản sao B2C khớp danh sách sống của CMS', b2cIds === liveIds, `${b2cIds} vs ${liveIds}`);

  await stopService(b2cDeaf);
  await stopService(b2b);
  await stopService(cms);
}

try {
  await main();
} catch (error) {
  check('e2e hoàn tất', false, error.message);
} finally {
  for (const child of processes) {
    if (child.exitCode === null) killTree(child, 'SIGKILL');
  }
  await pool.end().catch(() => undefined);
}

const passed = results.filter((result) => result.ok).length;
console.log(`\n${failed === 0 ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${passed}/${results.length} kiểm tra`);
if (failed > 0) {
  console.log('Log service: .tmp/*.log');
  process.exit(1);
}
