import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Module,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { country, supplier } from '@pubsub/contract';
import type { Pool } from 'pg';
import { CONFIG, type AppConfig } from '../config';
import { PG_POOL } from '../db/database.module';
import { EntityReader, EntityReaderModule } from '../entities/entity-reader';
import { EntitiesModule, EntityWriter, requireEntity } from '../entities/entity-writer';
import { ChangesModule, ChangesReader } from '../read/changes-reader';
import { PublisherWorker, SyncModule } from '../sync/sync.module';
import { AdminGuard } from './admin.guard';

@Controller()
export class HealthController {
  @Get('health')
  health(): { status: string; at: string } {
    return { status: 'ok', at: new Date().toISOString() };
  }
}

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly writer: EntityWriter,
    private readonly reader: EntityReader,
    private readonly changes: ChangesReader,
    @Inject(PublisherWorker) private readonly publisher: PublisherWorker,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('state')
  async state() {
    const { rows } = await this.pool.query<{ pending: string }>(
      'select count(*)::text as pending from sync_change where published_at is null',
    );
    return {
      fence: this.config.fence,
      publisher: this.publisher.stats,
      unpublished: Number(rows[0]?.pending ?? 0),
      headSeq: await this.changes.headSeq(),
      retentionDays: this.config.retentionDays,
      channels: this.config.channels,
    };
  }

  @Get('sync-changes')
  async outbox(
    @Query('afterSeq') afterSeq?: string,
    @Query('limit') limit?: string,
  ) {
    const after = Number(afterSeq ?? 0) || 0;
    const take = Math.min(Number(limit ?? 200) || 200, 500);

    const { rows } = await this.pool.query<{
      seq: string;
      entity: string;
      entity_id: string;
      version: number;
      change_type: string;
      published_at: string | null;
      txid: string;
      created_at: string;
    }>(
      `select seq, entity, entity_id, version, change_type, published_at,
              txid::text as txid, created_at
         from sync_change
        where seq > $1
        order by seq asc
        limit $2`,
      [after, take],
    );

    return rows.map((row) => ({
      seq: Number(row.seq),
      entity: row.entity,
      id: row.entity_id,
      version: row.version,
      changeType: row.change_type,
      publishedAt: row.published_at,
      txid: row.txid,
      createdAt: row.created_at,
    }));
  }

  /** Dữ liệu mẫu, tạo qua đúng đường ghi nên có đủ outbox. */
  @Post('seed')
  async seed() {
    if ((await this.reader.count(supplier)) === 0) {
      await this.writer.create(supplier, {
        name: 'Sunrise Hotels',
        description: 'Chuỗi khách sạn 4 sao ven biển miền Trung.',
        photos: ['https://example.com/sunrise-1.jpg', 'https://example.com/sunrise-2.jpg'],
        taxCode: '0401234567',
        costRate: '1250000',
        margin: '12.5',
        allotment: 40,
      });
      await this.writer.create(supplier, {
        name: 'Mekong Cruises',
        description: 'Du thuyền ngủ đêm tuyến Cần Thơ - Châu Đốc.',
        photos: ['https://example.com/mekong-1.jpg'],
        taxCode: '1801234567',
        costRate: '890000',
        margin: '15',
        allotment: 12,
      });
    }

    for (const row of [
      { id: 'VN', name: 'Việt Nam', description: 'Thị trường nội địa.', taxNote: 'VAT 8%' },
      { id: 'TH', name: 'Thái Lan', description: 'Điểm đến ngắn ngày.', taxNote: 'VAT 7%' },
      { id: 'JP', name: 'Nhật Bản', description: 'Mùa hoa anh đào tháng 3-4.', taxNote: 'JCT 10%' },
    ]) {
      if (!(await this.reader.find(country, row.id))) {
        await this.writer.create(country, row);
      }
    }

    return {
      suppliers: await this.reader.list(supplier),
      countries: await this.reader.list(country),
    };
  }

  @Post(':entity')
  create(@Param('entity') entityName: string, @Body() body: Record<string, unknown>) {
    return this.writer.create(requireEntity(entityName), body);
  }

  @Get(':entity')
  list(@Param('entity') entityName: string, @Query('includeDeleted') includeDeleted?: string) {
    return this.reader.list(requireEntity(entityName), includeDeleted === 'true');
  }

  @Get(':entity/:id')
  find(@Param('entity') entityName: string, @Param('id') id: string) {
    return this.reader.find(requireEntity(entityName), id);
  }

  @Patch(':entity/:id')
  update(
    @Param('entity') entityName: string,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.writer.update(requireEntity(entityName), id, body);
  }

  @Delete(':entity/:id')
  remove(@Param('entity') entityName: string, @Param('id') id: string) {
    return this.writer.softDelete(requireEntity(entityName), id);
  }
}

@Module({
  imports: [EntitiesModule, EntityReaderModule, ChangesModule, SyncModule],
  controllers: [AdminController, HealthController],
})
export class AdminModule {}
