import { Inject, Injectable } from '@nestjs/common';
import type { EntityMeta } from '@pubsub/contract';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/database.module';

export type ViewPayload = Record<string, unknown>;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(Number.isFinite(value) ? Math.trunc(value) : min, min), max);

/**
 * Đọc dữ liệu cho một view.
 *
 * SQL chỉ select đúng các cột mà view được phép thấy. Nhờ vậy cost/margin
 * không chỉ bị chặn ở SDL mà không bao giờ rời khỏi DB cho B2C.
 */
@Injectable()
export class ViewReader {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findOne(meta: EntityMeta, id: string): Promise<ViewPayload | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `select ${this.columns(meta)} from ${meta.table} where id = $1 and deleted_at is null`,
      [id],
    );
    const row = rows[0];
    return row ? this.project(meta, row) : null;
  }

  async list(
    meta: EntityMeta,
    options: { first?: number; after?: string | null },
  ): Promise<{
    nodes: ViewPayload[];
    pageInfo: { endCursor: string | null; hasNextPage: boolean };
  }> {
    const first = clamp(options.first ?? 50, 1, 200);
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `select ${this.columns(meta)} from ${meta.table}
        where deleted_at is null and ($1::text is null or id > $1)
        order by id asc
        limit $2`,
      [options.after ?? null, first + 1],
    );

    const hasNextPage = rows.length > first;
    const page = hasNextPage ? rows.slice(0, first) : rows;
    const last = page[page.length - 1];

    return {
      nodes: page.map((row) => this.project(meta, row)),
      pageInfo: { endCursor: last ? String(last.id) : null, hasNextPage },
    };
  }

  /** Chỉ cột của view này, không dùng `select *`. */
  private columns(meta: EntityMeta): string {
    return meta.fields.map((field) => `"${field.column}"`).join(', ');
  }

  private project(meta: EntityMeta, row: Record<string, unknown>): ViewPayload {
    const payload: ViewPayload = {};
    for (const field of meta.fields) payload[field.name] = row[field.column] ?? null;
    return payload;
  }
}
