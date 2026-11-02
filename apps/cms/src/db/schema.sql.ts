/**
 * Bảng `sync_change` làm ba việc: outbox, tombstone, cursor.
 *
 * `txid xid8` ghi lại transaction đã tạo dòng. Đây là thứ cho phép cursor
 * không bỏ sót dòng khi hai transaction commit chồng nhau.
 */
export const CMS_SCHEMA_SQL = `
create table if not exists supplier (
  id          text primary key,
  name        text not null,
  description text,
  photos      jsonb not null default '[]'::jsonb,
  tax_code    text,
  cost_rate   text not null,
  margin      text not null,
  allotment   integer not null,
  version     integer not null default 1,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists country (
  id          text primary key,
  name        text not null,
  description text,
  tax_note    text,
  version     integer not null default 1,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists sync_change (
  seq          bigint generated always as identity primary key,
  entity       text not null,
  entity_id    text not null,
  version      integer not null,
  change_type  text not null check (change_type in ('created', 'updated', 'deleted')),
  txid         xid8 not null,
  published_at timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists sync_change_pending_idx on sync_change (seq) where published_at is null;
create index if not exists sync_change_entity_idx on sync_change (entity, entity_id, seq desc);
`;
