import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { MirrorStore } from '../src/mirror-store';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://demo:demo@localhost:45432/cms';
const SCHEMA = 'test_consumer_kit';
const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
const store = new MirrorStore(pool, SCHEMA);

beforeAll(async () => {
  await store.migrate();
});

beforeEach(async () => {
  await pool.query(`truncate ${SCHEMA}.mirror`);
  await pool.query(`update ${SCHEMA}.sync_cursor set last_seq = 0 where id = 'default'`);
});

afterAll(async () => {
  await pool.query(`drop schema if exists ${SCHEMA} cascade`);
  await pool.end();
});

describe('bản sao của consumer', () => {
  it('version thấp hơn không ghi đè bản mới hơn', async () => {
    expect(await store.upsert('supplier', 's_1', 3, { id: 's_1', version: 3 })).toBe(true);
    expect(await store.upsert('supplier', 's_1', 2, { id: 's_1', version: 2 })).toBe(false);

    const rows = await store.list('supplier');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.version).toBe(3);
  });

  it('tombstone giữ version và chặn pull chậm làm sống lại bản ghi', async () => {
    await store.upsert('supplier', 's_2', 7, { id: 's_2', version: 7 });

    // DELETED version 9 tới trước
    expect(await store.remove('supplier', 's_2', 9)).toBe(true);
    expect(await store.list('supplier')).toEqual([]);
    expect(await store.getVersion('supplier', 's_2')).toBe(9);

    // response của pull version 8 (đang bay lúc xoá) về sau: phải bị chặn
    expect(await store.upsert('supplier', 's_2', 8, { id: 's_2', version: 8 })).toBe(false);
    expect(await store.list('supplier')).toEqual([]);
  });

  it('bản ghi được tạo lại với version cao hơn thì hiện lại', async () => {
    await store.upsert('supplier', 's_3', 1, { id: 's_3', version: 1 });
    await store.remove('supplier', 's_3', 2);
    expect(await store.list('supplier')).toEqual([]);

    expect(await store.upsert('supplier', 's_3', 3, { id: 's_3', version: 3 })).toBe(true);
    expect(await store.list('supplier')).toHaveLength(1);
  });

  it('cursor đọc/ghi được và mặc định là 0', async () => {
    expect(await store.getCursor()).toBe(0);
    await store.setCursor(42);
    expect(await store.getCursor()).toBe(42);
  });
});
