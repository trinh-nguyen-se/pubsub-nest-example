import { Inject, Injectable, Module } from '@nestjs/common';
import type { EntityDefinition } from '@pubsub/contract';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/database.module';
import { mapRow } from './map-row';

export type AdminRow = Record<string, unknown> & {
  deletedAt: string | null;
  updatedAt: string | null;
};

/** Đọc cho admin: thấy hết cột, kể cả bản ghi đã xoá mềm. */
@Injectable()
export class EntityReader {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async list(definition: EntityDefinition, includeDeleted = false): Promise<AdminRow[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `select * from ${definition.table}
        ${includeDeleted ? '' : 'where deleted_at is null'}
        order by id asc`,
    );
    return rows.map((row) => this.toAdminRow(definition, row));
  }

  async find(definition: EntityDefinition, id: string): Promise<AdminRow | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `select * from ${definition.table} where id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? this.toAdminRow(definition, row) : null;
  }

  async count(definition: EntityDefinition): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `select count(*)::text as count from ${definition.table} where deleted_at is null`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  private toAdminRow(definition: EntityDefinition, row: Record<string, unknown>): AdminRow {
    return {
      ...mapRow(definition, row),
      deletedAt: row.deleted_at ? String(row.deleted_at) : null,
      updatedAt: row.updated_at ? String(row.updated_at) : null,
    };
  }
}

@Module({ providers: [EntityReader], exports: [EntityReader] })
export class EntityReaderModule {}
