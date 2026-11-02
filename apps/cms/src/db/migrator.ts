import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from './database.module';
import { CMS_SCHEMA_SQL } from './schema.sql';

@Injectable()
export class Migrator implements OnModuleInit {
  private readonly logger = new Logger(Migrator.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleInit(): Promise<void> {
    await this.pool.query(CMS_SCHEMA_SQL);
    this.logger.log('schema CMS sẵn sàng (supplier, country, sync_change)');
  }
}
