import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Pool } from 'pg';
import type { ConsumerConfig } from './config';
import { GraphqlClient } from './graphql-client';
import { MirrorStore } from './mirror-store';
import { SyncEngine } from './sync-engine';

export const CONSUMER_CONFIG = Symbol('CONSUMER_CONFIG');
export const MIRROR_STORE = Symbol('MIRROR_STORE');
export const GRAPHQL_CLIENT = Symbol('GRAPHQL_CLIENT');
export const SYNC_ENGINE = Symbol('SYNC_ENGINE');

@Injectable()
export class ConsumerLifecycle implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(@Inject(SYNC_ENGINE) private readonly engine: SyncEngine) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.engine.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.engine.stop();
  }
}

@Controller()
export class ConsumerController {
  constructor(
    @Inject(CONSUMER_CONFIG) private readonly config: ConsumerConfig,
    @Inject(MIRROR_STORE) private readonly store: MirrorStore,
    @Inject(SYNC_ENGINE) private readonly engine: SyncEngine,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok', view: this.config.view, at: new Date().toISOString() };
  }

  @Get('mirror/state')
  async state() {
    const [engineState, cursor] = await Promise.all([
      this.engine.state(),
      this.store.getCursor(),
    ]);
    return {
      config: {
        view: this.config.view,
        channel: this.config.channel,
        dropMessages: this.config.dropMessages,
      },
      ...engineState,
      cursor,
    };
  }

  @Get('mirror/events')
  events() {
    return this.store.recentEvents(30);
  }

  @Post('mirror/reconcile')
  reconcile() {
    return this.engine.reconcileNow();
  }

  @Get('mirror/:entity')
  list(@Param('entity') entity: string) {
    return this.store.list(entity);
  }
}

/**
 * Một khung consumer dùng cho cả B2B và B2C. Khác biệt giữa hai bên nằm ở
 * config (view, token, channel, schema), không nằm ở code.
 */
@Module({})
export class ConsumerModule {
  static forRoot(config: ConsumerConfig): DynamicModule {
    return {
      module: ConsumerModule,
      controllers: [ConsumerController],
      providers: [
        { provide: CONSUMER_CONFIG, useValue: config },
        {
          provide: MIRROR_STORE,
          inject: [CONSUMER_CONFIG],
          useFactory: (cfg: ConsumerConfig) =>
            new MirrorStore(
              new Pool({
                connectionString: cfg.databaseUrl,
                max: 5,
                application_name: `consumer-${cfg.view}`,
              }),
              cfg.schema,
            ),
        },
        {
          provide: GRAPHQL_CLIENT,
          inject: [CONSUMER_CONFIG],
          useFactory: (cfg: ConsumerConfig) =>
            new GraphqlClient(cfg.cmsGraphqlUrl, cfg.view, cfg.token),
        },
        {
          provide: SYNC_ENGINE,
          inject: [CONSUMER_CONFIG, MIRROR_STORE, GRAPHQL_CLIENT],
          useFactory: (cfg: ConsumerConfig, store: MirrorStore, gql: GraphqlClient) =>
            new SyncEngine(cfg, store, gql),
        },
        ConsumerLifecycle,
      ],
    };
  }
}
