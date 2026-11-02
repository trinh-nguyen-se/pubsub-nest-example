import type { Pool } from 'pg';

export type MirrorRow = { entity: string; id: string; version: number; payload: Record<string, unknown>; syncedAt: string };
export type SyncEvent = {
  at: string;
  kind: string;
  entity: string | null;
  entityId: string | null;
  version: number | null;
  seq: number | null;
  detail: string | null;
};

/**
 * DB riêng của consumer. Consumer không bao giờ đọc thẳng bảng của CMS —
 * nó giữ bản sao của mình, đúng như B2B/B2C thật sẽ làm.
 */
export class MirrorStore {
  constructor(
    private readonly pool: Pool,
    private readonly schema: string,
  ) {}

  async migrate(): Promise<void> {
    await this.pool.query(`
      create schema if not exists ${this.schema};

      create table if not exists ${this.schema}.mirror (
        entity     text not null,
        id         text not null,
        version    integer not null,
        payload    jsonb not null,
        deleted_at timestamptz,
        synced_at  timestamptz not null default now(),
        primary key (entity, id)
      );

      -- bản cũ chưa có cột tombstone
      alter table ${this.schema}.mirror add column if not exists deleted_at timestamptz;

      create table if not exists ${this.schema}.sync_cursor (
        id       text primary key,
        last_seq bigint not null default 0,
        updated_at timestamptz not null default now()
      );

      insert into ${this.schema}.sync_cursor (id, last_seq) values ('default', 0)
      on conflict (id) do nothing;

      create table if not exists ${this.schema}.sync_event (
        id        bigserial primary key,
        at        timestamptz not null default now(),
        kind      text not null,
        entity    text,
        entity_id text,
        version   integer,
        seq       bigint,
        detail    text
      );
    `);
  }

  async getVersion(entity: string, id: string): Promise<number | null> {
    const { rows } = await this.pool.query<{ version: number }>(
      `select version from ${this.schema}.mirror where entity = $1 and id = $2`,
      [entity, id],
    );
    return rows[0]?.version ?? null;
  }

  /**
   * Ghi đè chỉ khi version mới hơn **thật sự**. Guard theo version (không phải
   * delete trần) là thứ chống lại việc một lần `pull` chậm làm sống lại bản ghi
   * vừa bị xoá.
   */
  async upsert(
    entity: string,
    id: string,
    version: number,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `insert into ${this.schema}.mirror (entity, id, version, payload, deleted_at, synced_at)
       values ($1, $2, $3, $4::jsonb, null, now())
       on conflict (entity, id) do update
         set version = excluded.version,
             payload = excluded.payload,
             deleted_at = null,
             synced_at = now()
       where ${this.schema}.mirror.version < excluded.version`,
      [entity, id, version, JSON.stringify(payload)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Xoá mềm: giữ tombstone kèm version, không `delete` trần.
   *
   * Nếu chỉ delete, kịch bản này sẽ hồi sinh bản ghi: message UPDATED v8 đang
   * gọi `pull()` thì message DELETED v9 tới, xoá dòng; sau đó response v8 về và
   * chèn lại — bản ghi chết sống dậy mà CMS không phát thêm change nào nữa.
   */
  async remove(entity: string, id: string, version: number): Promise<boolean> {
    const result = await this.pool.query(
      `insert into ${this.schema}.mirror (entity, id, version, payload, deleted_at, synced_at)
       values ($1, $2, $3, '{}'::jsonb, now(), now())
       on conflict (entity, id) do update
         set version = excluded.version,
             payload = '{}'::jsonb,
             deleted_at = now(),
             synced_at = now()
       where ${this.schema}.mirror.version < excluded.version`,
      [entity, id, version],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async list(entity: string): Promise<MirrorRow[]> {
    const { rows } = await this.pool.query<{
      entity: string;
      id: string;
      version: number;
      payload: Record<string, unknown>;
      synced_at: string;
    }>(
      `select entity, id, version, payload, synced_at
         from ${this.schema}.mirror
        where entity = $1 and deleted_at is null
        order by id asc`,
      [entity],
    );
    return rows.map((row) => ({
      entity: row.entity,
      id: row.id,
      version: row.version,
      payload: row.payload,
      syncedAt: row.synced_at,
    }));
  }

  async summary(): Promise<Record<string, number>> {
    const { rows } = await this.pool.query<{ entity: string; count: string }>(
      `select entity, count(*)::text as count
         from ${this.schema}.mirror
        where deleted_at is null
        group by entity
        order by entity`,
    );
    return Object.fromEntries(rows.map((row) => [row.entity, Number(row.count)]));
  }

  async getCursor(): Promise<number> {
    const { rows } = await this.pool.query<{ last_seq: string }>(
      `select last_seq from ${this.schema}.sync_cursor where id = 'default'`,
    );
    return Number(rows[0]?.last_seq ?? 0);
  }

  async setCursor(seq: number): Promise<void> {
    await this.pool.query(
      `update ${this.schema}.sync_cursor set last_seq = $1, updated_at = now() where id = 'default'`,
      [seq],
    );
  }

  async recordEvent(event: {
    kind: string;
    entity?: string | null;
    entityId?: string | null;
    version?: number | null;
    seq?: number | null;
    detail?: string | null;
  }): Promise<void> {
    await this.pool.query(
      `insert into ${this.schema}.sync_event (kind, entity, entity_id, version, seq, detail)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        event.kind,
        event.entity ?? null,
        event.entityId ?? null,
        event.version ?? null,
        event.seq ?? null,
        event.detail ?? null,
      ],
    );
    // giữ log gọn: chỉ 200 dòng gần nhất
    await this.pool.query(
      `delete from ${this.schema}.sync_event
        where id <= (select coalesce(max(id), 0) - 200 from ${this.schema}.sync_event)`,
    );
  }

  async recentEvents(limit = 30): Promise<SyncEvent[]> {
    const { rows } = await this.pool.query<{
      at: string;
      kind: string;
      entity: string | null;
      entity_id: string | null;
      version: number | null;
      seq: string | null;
      detail: string | null;
    }>(
      `select at, kind, entity, entity_id, version, seq, detail
         from ${this.schema}.sync_event
        order by id desc
        limit $1`,
      [Math.min(limit, 200)],
    );
    return rows.map((row) => ({
      at: row.at,
      kind: row.kind,
      entity: row.entity,
      entityId: row.entity_id,
      version: row.version,
      seq: row.seq === null ? null : Number(row.seq),
      detail: row.detail,
    }));
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
