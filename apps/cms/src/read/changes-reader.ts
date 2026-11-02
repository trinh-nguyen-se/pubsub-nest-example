import { Inject, Injectable, Module } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/database.module';
import { selectChanges, selectHeadSeq } from '../sync/fence';
import { toChangeTypeName, type ChangeTypeName } from '../sync/change-message';

export type ChangePayload = {
  seq: number;
  entity: string;
  id: string;
  version: number;
  changeType: ChangeTypeName;
};

const clampLimit = (limit: number): number =>
  Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 200, 1), 500);

@Injectable()
export class ChangesReader {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async read(options: { afterSeq: number; limit: number; entities?: string[] }): Promise<ChangePayload[]> {
    const rows = await selectChanges(this.pool, {
      afterSeq: Math.max(0, Math.trunc(options.afterSeq)),
      limit: clampLimit(options.limit),
      entities: options.entities,
    });

    return rows.map((row) => ({
      seq: row.seq,
      entity: row.entity,
      id: row.entityId,
      version: row.version,
      changeType: toChangeTypeName(row.changeType),
    }));
  }

  async headSeq(): Promise<number> {
    return selectHeadSeq(this.pool);
  }
}

@Module({ providers: [ChangesReader], exports: [ChangesReader] })
export class ChangesModule {}
