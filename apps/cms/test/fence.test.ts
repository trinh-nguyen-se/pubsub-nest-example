import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { CMS_SCHEMA_SQL } from '../src/db/schema.sql';
import {
  recordChange,
  selectChanges,
  selectHeadSeq,
  selectPending,
  type FenceStrategy,
} from '../src/sync/fence';
import { EntityWriter } from '../src/entities/entity-writer';
import { supplier } from '@pubsub/contract';
import type { AppConfig } from '../src/config';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://demo:demo@localhost:45432/cms';
const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const reset = async (): Promise<void> => {
  await pool.query('truncate sync_change restart identity');
  await pool.query('truncate supplier restart identity');
};

const insertSupplier = (
  client: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
  id: string,
): Promise<unknown> =>
  client.query(
    `insert into supplier (id, name, cost_rate, margin, allotment) values ($1, $2, '1', '1', 1)`,
    [id, id],
  );

/**
 * Bài lab trung tâm: hai transaction commit chồng nhau.
 *
 * Hai transaction đều ghi entity trước (điều này cấp txid), rồi mới ghi outbox
 * (cấp seq) — đúng hình dạng thật của EntityWriter.
 */
describe('rào cursor khi hai transaction commit chồng nhau', () => {
  beforeAll(async () => {
    await pool.query(CMS_SCHEMA_SQL);
  });

  it('không có khoá: cursor seq trơn bỏ sót dòng đang mở', async () => {
    await reset();

    const slow = await pool.connect();
    const fast = await pool.connect();

    try {
      // Tx A ghi trước, giữ transaction mở
      await slow.query('begin');
      await insertSupplier(slow, 's_slow');
      const seqA = await recordChange(
        slow,
        { entity: 'supplier', entityId: 's_slow', version: 1, changeType: 'created' },
        'none',
      );

      // Tx B ghi sau nhưng commit trước
      await fast.query('begin');
      await insertSupplier(fast, 's_fast');
      const seqB = await recordChange(
        fast,
        { entity: 'supplier', entityId: 's_fast', version: 1, changeType: 'created' },
        'none',
      );
      await fast.query('commit');

      const firstRead = await selectChanges(pool, { afterSeq: 0, limit: 10 });
      expect(firstRead.map((row) => row.seq)).toEqual([seqB]);
      const cursor = firstRead[firstRead.length - 1]!.seq;

      // A commit muộn: dòng seqA nằm dưới cursor và không bao giờ được trả lại
      await slow.query('commit');
      const secondRead = await selectChanges(pool, { afterSeq: cursor, limit: 10 });

      expect(seqA).toBeLessThan(seqB);
      expect(secondRead).toEqual([]);

      const stillInTable = await pool.query('select 1 from sync_change where seq = $1', [seqA]);
      expect(stillInTable.rowCount).toBe(1);
    } finally {
      slow.release();
      fast.release();
    }
  });

  it('khoá advisory: transaction sau phải đợi commit trước, nên không bỏ sót', async () => {
    await reset();

    const slow = await pool.connect();
    const fast = await pool.connect();

    try {
      await slow.query('begin');
      await insertSupplier(slow, 's_slow');
      const seqA = await recordChange(
        slow,
        { entity: 'supplier', entityId: 's_slow', version: 1, changeType: 'created' },
        'advisory',
      );

      // Trong lúc A còn mở, consumer không thấy gì: dòng A chưa commit.
      expect(await selectChanges(pool, { afterSeq: 0, limit: 10 })).toEqual([]);

      await fast.query('begin');
      await insertSupplier(fast, 's_fast');
      const insertB = recordChange(
        fast,
        { entity: 'supplier', entityId: 's_fast', version: 1, changeType: 'created' },
        'advisory',
      );

      // B phải bị chặn ở khoá advisory cho tới khi A commit
      const state = await Promise.race([
        insertB.then(() => 'resolved' as const),
        sleep(200).then(() => 'blocked' as const),
      ]);
      expect(state).toBe('blocked');

      await slow.query('commit');
      const seqB = await insertB;
      await fast.query('commit');

      expect(seqA).toBeLessThan(seqB);

      const rows = await selectChanges(pool, { afterSeq: 0, limit: 10 });
      expect(rows.map((row) => row.seq)).toEqual([seqA, seqB]);
    } finally {
      slow.release();
      fast.release();
    }
  });

  it('advisory: txid và seq không thể đảo thứ tự', async () => {
    await reset();

    // A lấy txid trước (nhờ ghi entity), nhưng để B ghi outbox trước.
    const earlyXid = await pool.connect();
    const lateXid = await pool.connect();

    try {
      await earlyXid.query('begin');
      await insertSupplier(earlyXid, 's_early_xid');

      await lateXid.query('begin');
      await insertSupplier(lateXid, 's_late_xid');

      // A ghi outbox trước → giữ khoá, seq nhỏ hơn, và phải commit trước.
      const seqEarly = await recordChange(
        earlyXid,
        { entity: 'supplier', entityId: 's_early_xid', version: 1, changeType: 'created' },
        'advisory',
      );

      const pendingLate = recordChange(
        lateXid,
        { entity: 'supplier', entityId: 's_late_xid', version: 1, changeType: 'created' },
        'advisory',
      );

      const blocked = await Promise.race([
        pendingLate.then(() => 'resolved' as const),
        sleep(150).then(() => 'blocked' as const),
      ]);
      expect(blocked).toBe('blocked');

      await earlyXid.query('commit');
      const seqLate = await pendingLate;
      await lateXid.query('commit');

      expect(seqEarly).toBeLessThan(seqLate);

      const rows = await selectChanges(pool, { afterSeq: 0, limit: 10 });
      expect(rows.map((row) => row.seq)).toEqual([seqEarly, seqLate]);
      expect(await selectHeadSeq(pool)).toBe(seqLate);
    } finally {
      earlyXid.release();
      lateXid.release();
    }
  });

  it('publisher chỉ thấy dòng đã commit', async () => {
    await reset();

    const tx = await pool.connect();
    try {
      await tx.query('begin');
      await recordChange(
        tx,
        { entity: 'supplier', entityId: 's_pending', version: 1, changeType: 'created' },
        'advisory',
      );

      expect(await selectPending(pool, { limit: 10 })).toEqual([]);

      await tx.query('commit');
      expect(await selectPending(pool, { limit: 10 })).toHaveLength(1);
    } finally {
      tx.release();
    }
  });
});

describe('outbox ghi cùng transaction với dữ liệu', () => {
  const config = { fence: 'advisory' as FenceStrategy } as unknown as AppConfig;

  beforeAll(async () => {
    await pool.query(CMS_SCHEMA_SQL);
  });

  it('create → update → soft delete sinh đúng ba dòng, version tăng dần, có tombstone', async () => {
    await reset();
    const writer = new EntityWriter(pool, config);

    const created = await writer.create(supplier, {
      name: 'Test Supplier',
      description: 'mô tả',
      photos: ['https://example.com/a.jpg'],
      taxCode: '0100000000',
      costRate: '100',
      margin: '10',
      allotment: 5,
    });
    const id = String(created.id);

    await writer.update(supplier, id, { name: 'Test Supplier 2' });
    await writer.softDelete(supplier, id);

    expect(created.version).toBe(1);

    const rows = await selectChanges(pool, { afterSeq: 0, limit: 10 });
    expect(rows.map((row) => [row.changeType, row.version])).toEqual([
      ['created', 1],
      ['updated', 2],
      ['deleted', 3],
    ]);
  });

  it('rollback thì dòng outbox biến mất theo — không có thông báo ma', async () => {
    await reset();
    const tx = await pool.connect();
    try {
      await tx.query('begin');
      await recordChange(
        tx,
        { entity: 'supplier', entityId: 's_ghost', version: 1, changeType: 'created' },
        'advisory',
      );
      await tx.query('rollback');
    } finally {
      tx.release();
    }

    expect(await selectChanges(pool, { afterSeq: 0, limit: 10 })).toEqual([]);
  });

  it('changes() lọc theo entity của view', async () => {
    await reset();
    const writer = new EntityWriter(pool, config);

    await writer.create(supplier, {
      name: 'Chỉ thấy ở view có supplier',
      description: 'x',
      photos: [],
      taxCode: null,
      costRate: '1',
      margin: '1',
      allotment: 1,
    });

    expect(await selectChanges(pool, { afterSeq: 0, limit: 10, entities: ['supplier'] })).toHaveLength(1);
    expect(await selectChanges(pool, { afterSeq: 0, limit: 10, entities: ['country'] })).toHaveLength(0);
  });
});

afterAll(async () => {
  await pool.end();
});
