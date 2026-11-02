import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { CONFIG, type AppConfig } from '../config';

export const PG_POOL = Symbol('PG_POOL');

@Injectable()
export class PoolLifecycle implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [CONFIG],
      useFactory: (config: AppConfig): Pool =>
        new Pool({ connectionString: config.databaseUrl, max: 10, application_name: 'cms' }),
    },
    PoolLifecycle,
  ],
  exports: [PG_POOL],
})
export class DatabaseModule {}
