/**
 * Bài lab: cùng một kịch bản, hai cách ghi.
 *
 *   Tx A ghi entity trước (được cấp txid), rồi ghi outbox (được cấp seq) và giữ transaction mở.
 *   Tx B ghi entity sau, ghi outbox sau A, rồi commit trước A.
 *
 * Chạy: pnpm lab   (dùng schema `lab` riêng, không đụng bảng thật)
 */
import { Pool } from 'pg';
import { CMS_SCHEMA_SQL } from '../apps/cms/src/db/schema.sql';
import { recordChange, selectChanges, type FenceStrategy } from '../apps/cms/src/sync/fence';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://demo:demo@localhost:45432/cms';

// search_path trỏ vào schema lab: mọi câu SQL không đụng dữ liệu thật của CMS.
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 5,
  options: '-c search_path=lab,public',
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Outcome = {
  strategy: FenceStrategy;
  seqA: number;
  seqB: number;
  readWhileOpen: number[];
  cursor: number;
  secondRead: number[];
  lost: number[];
  blockedMs: number | null;
};

const insertSupplier = (
  client: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
  id: string,
) =>
  client.query(
    `insert into supplier (id, name, cost_rate, margin, allotment) values ($1, $1, '1', '1', 1)`,
    [id],
  );

async function run(strategy: FenceStrategy): Promise<Outcome> {
  await pool.query('truncate lab.sync_change restart identity');
  await pool.query('truncate lab.supplier restart identity');

  const slow = await pool.connect();
  const fast = await pool.connect();

  try {
    await slow.query('begin');
    await insertSupplier(slow, 's_slow');
    const seqA = await recordChange(
      slow,
      { entity: 'supplier', entityId: 's_slow', version: 1, changeType: 'created' },
      strategy,
    );

    await fast.query('begin');
    await insertSupplier(fast, 's_fast');

    if (strategy === 'advisory') {
      // B sẽ bị chặn ở khoá advisory cho tới khi A commit
      const startedAt = Date.now();
      const insertB = recordChange(
        fast,
        { entity: 'supplier', entityId: 's_fast', version: 1, changeType: 'created' },
        strategy,
      );

      const readWhileOpen = await selectChanges(pool, { afterSeq: 0, limit: 10 });

      await sleep(150);
      const blockedMs = Date.now() - startedAt;

      await slow.query('commit');
      const seqB = await insertB;
      await fast.query('commit');

      return {
        strategy,
        seqA,
        seqB,
        readWhileOpen: readWhileOpen.map((row) => row.seq),
        cursor: seqB,
        secondRead: [],
        lost: [],
        blockedMs,
      };
    }

    const seqB = await recordChange(
      fast,
      { entity: 'supplier', entityId: 's_fast', version: 1, changeType: 'created' },
      strategy,
    );
    await fast.query('commit');

    const firstRead = await selectChanges(pool, { afterSeq: 0, limit: 10 });
    const cursor = firstRead.at(-1)?.seq ?? 0;

    // A commit muộn
    await slow.query('commit');

    const secondRead = await selectChanges(pool, { afterSeq: cursor, limit: 10 });

    return {
      strategy,
      seqA,
      seqB,
      readWhileOpen: firstRead.map((row) => row.seq),
      cursor,
      secondRead: secondRead.map((row) => row.seq),
      lost: [seqA, seqB].filter(
        (seq) =>
          !firstRead.some((row) => row.seq === seq) && !secondRead.some((row) => row.seq === seq),
      ),
      blockedMs: null,
    };
  } finally {
    slow.release();
    fast.release();
  }
}

async function main(): Promise<void> {
  await pool.query(CMS_SCHEMA_SQL);
  await pool.query(`
    create schema if not exists lab;
    create table if not exists lab.sync_change (like public.sync_change including all);
    create table if not exists lab.supplier (like public.supplier including all);
  `);

  console.log('Kịch bản: A ghi trước nhưng commit muộn; B ghi sau, commit trước.\n');

  const outcomes = [await run('none'), await run('advisory')];

  for (const outcome of outcomes) {
    const label =
      outcome.strategy === 'none'
        ? 'none      (không khoá — cursor seq trơn)'
        : 'advisory  (khoá advisory lúc ghi)';
    console.log(`■ ${label}`);
    console.log(`   seq cấp cho A/B   : ${outcome.seqA} / ${outcome.seqB}`);
    console.log(
      `   B bị chặn         : ${
        outcome.blockedMs === null ? 'không' : `có, ~${outcome.blockedMs}ms (đợi A commit)`
      }`,
    );
    console.log(`   đọc khi A còn mở  : [${outcome.readWhileOpen.join(', ')}]`);
    console.log(`   cursor nhớ        : ${outcome.cursor}`);
    console.log(
      `   đọc lại sau commit: [${outcome.strategy === 'advisory' ? `${outcome.seqA}, ${outcome.seqB}` : outcome.secondRead.join(', ')}]`,
    );
    console.log(
      `   dòng bị mất       : ${
        outcome.lost.length === 0
          ? 'không'
          : `[${outcome.lost.join(', ')}]  ← consumer không bao giờ thấy`
      }\n`,
    );
  }

  console.log('Kết luận:');
  console.log('  none      → sai. Transaction commit muộn nằm dưới cursor đã nhảy qua.');
  console.log('  advisory  → đúng. Ghi outbox tuần tự hoá nên commit order = seq order.');
  console.log('  Cái giá   : mọi transaction ghi outbox xếp hàng ở một khoá duy nhất.');
  console.log('  Xem docs/fence-investigation.md cho phương án song song (cursor = txid).');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
