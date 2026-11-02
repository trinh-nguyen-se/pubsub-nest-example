import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Module, NotFoundException } from '@nestjs/common';
import {
  columnOf,
  entityByName,
  gqlTypeOf,
  registry,
  type EntityDefinition,
} from '@pubsub/contract';
import type { Pool, PoolClient } from 'pg';
import { CONFIG, type AppConfig } from '../config';
import { PG_POOL } from '../db/database.module';
import { recordChange } from '../sync/fence';
import { encodeValue, mapRow } from './map-row';

/** Cho phép gọi bằng tên hoặc dạng số nhiều trong URL: /admin/suppliers. */
export const requireEntity = (nameOrPlural: string): EntityDefinition => {
  const definition =
    entityByName(nameOrPlural) ?? registry.find((candidate) => candidate.plural === nameOrPlural);
  if (!definition) {
    throw new NotFoundException(`entity "${nameOrPlural}" không có trong registry`);
  }
  return definition;
};

/**
 * Ghi entity + ghi outbox trong **cùng một transaction**.
 * Đây là chỗ duy nhất trong CMS được phép sinh thay đổi đồng bộ.
 */
@Injectable()
export class EntityWriter {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async create(definition: EntityDefinition, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    // Field nullable coi như có thể bỏ trống khi tạo: điền null thay vì bắt
    // client gửi đủ key. Field bắt buộc vẫn phải có — sai thì 400, không phải 500.
    const normalized: Record<string, unknown> = { ...input };
    for (const name of definition.fieldNames) {
      const gqlType = gqlTypeOf(name, definition.fields[name]!);
      if (!gqlType.endsWith('!') && normalized[name] === undefined) normalized[name] = null;
    }

    const parsed = definition.schema.omit({ version: true }).partial({ id: true }).parse(normalized);
    const providedId = typeof parsed.id === 'string' ? parsed.id : undefined;

    if (!providedId && !definition.idPrefix) {
      throw new BadRequestException(`entity "${definition.name}" cần id do client cấp`);
    }
    const id = providedId ?? `${definition.idPrefix}${randomUUID().slice(0, 8)}`;

    return this.inTransaction(async (tx) => {
      const columns = definition.fieldNames.filter((name) => name !== 'id' && name !== 'version');
      const values = columns.map((name) => encodeValue(parsed[name]));
      const placeholders = columns.map((_, index) => `$${index + 2}`);
      const columnList = columns.map((name) => columnOf(name, definition.fields[name]!));

      const { rows } = await tx.query<Record<string, unknown>>(
        `insert into ${definition.table} (id, version${columnList.map((column) => `, ${column}`).join('')})
         values ($1, 1${placeholders.length > 0 ? `, ${placeholders.join(', ')}` : ''})
         returning *`,
        [id, ...values],
      );

      const row = rows[0]!;
      await recordChange(
        tx,
        { entity: definition.name, entityId: id, version: Number(row.version), changeType: 'created' },
        this.config.fence,
      );
      return mapRow(definition, row);
    });
  }

  async update(
    definition: EntityDefinition,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const parsed = definition.schema.omit({ id: true, version: true }).partial().parse(patch);
    const entries = Object.entries(parsed).filter(([, value]) => value !== undefined);

    if (entries.length === 0) throw new BadRequestException('không có field nào để cập nhật');

    return this.inTransaction(async (tx) => {
      const sets = entries.map(
        ([name, value], index) => `${columnOf(name, definition.fields[name]!)} = $${index + 2}`,
      );
      const { rows } = await tx.query<Record<string, unknown>>(
        `update ${definition.table}
            set ${sets.join(', ')}, version = version + 1, updated_at = now()
          where id = $1 and deleted_at is null
          returning *`,
        [id, ...entries.map(([, value]) => encodeValue(value))],
      );

      const row = rows[0];
      if (!row) throw new NotFoundException(`${definition.name} "${id}" không tồn tại`);

      await recordChange(
        tx,
        { entity: definition.name, entityId: id, version: Number(row.version), changeType: 'updated' },
        this.config.fence,
      );
      return mapRow(definition, row);
    });
  }

  /** Xoá mềm để còn tombstone cho consumer. Xoá cứng sẽ làm consumer không bao giờ biết. */
  async softDelete(definition: EntityDefinition, id: string): Promise<Record<string, unknown>> {
    return this.inTransaction(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `update ${definition.table}
            set deleted_at = now(), version = version + 1, updated_at = now()
          where id = $1 and deleted_at is null
          returning *`,
        [id],
      );

      const row = rows[0];
      if (!row) throw new NotFoundException(`${definition.name} "${id}" không tồn tại hoặc đã xoá`);

      await recordChange(
        tx,
        { entity: definition.name, entityId: id, version: Number(row.version), changeType: 'deleted' },
        this.config.fence,
      );
      return mapRow(definition, row);
    });
  }

  private async inTransaction<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}

@Module({ providers: [EntityWriter], exports: [EntityWriter] })
export class EntitiesModule {}
