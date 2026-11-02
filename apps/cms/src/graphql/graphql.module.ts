import { Inject, Logger, Module, type MiddlewareConsumer, type NestModule, type OnModuleDestroy } from '@nestjs/common';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express5';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { contractByView, VIEWS, type View } from '@pubsub/contract';
import type { NextFunction, Request, Response } from 'express';
import { CONFIG, type AppConfig } from '../config';
import { ChangesModule, ChangesReader } from '../read/changes-reader';
import { ViewReader } from '../read/view-reader';
import { authenticate } from './auth';
import { buildResolvers } from './resolvers';

/**
 * Hai endpoint, hai schema, hai token. Một request không thể "nhìn thấy" schema
 * của view còn lại vì nó chưa từng được nạp vào cùng một Apollo server.
 */
@Module({ imports: [ChangesModule], providers: [ViewReader] })
export class GraphqlModule implements NestModule, OnModuleDestroy {
  private readonly logger = new Logger(GraphqlModule.name);
  private readonly servers = new Map<View, ApolloServer>();
  private readonly ready: Promise<void>;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly reader: ViewReader,
    private readonly changes: ChangesReader,
  ) {
    this.ready = this.startServers();
  }

  configure(consumer: MiddlewareConsumer): void {
    for (const view of VIEWS) {
      consumer.apply(this.handler(view)).forRoutes(`graphql/${view}/v1`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.servers.values()].map((server) => server.stop()));
  }

  private async startServers(): Promise<void> {
    for (const view of VIEWS) {
      const contract = contractByView[view];
      const schema = makeExecutableSchema({
        typeDefs: contract.sdl,
        resolvers: buildResolvers(view, { reader: this.reader, changes: this.changes }),
      });

      const server = new ApolloServer({
        schema,
        introspection: this.config.introspection,
      });

      await server.start();
      this.servers.set(view, server);
      this.logger.log(`GraphQL /graphql/${view}/v1 · ${Object.keys(contract.entities).length} entity`);
    }
  }

  private handler(view: View) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const auth = authenticate(view, req, this.config);
      if (!auth.ok) {
        res.status(auth.status).json({
          errors: [{ message: auth.message, extensions: { code: auth.code } }],
        });
        return;
      }

      try {
        await this.ready;
        const server = this.servers.get(view);
        if (!server) throw new Error(`Apollo server cho view ${view} chưa sẵn sàng`);

        await expressMiddleware(server, {
          context: async () => ({ view }),
        })(req, res, next);
      } catch (error) {
        this.logger.error(`GraphQL ${view} lỗi: ${(error as Error).message}`);
        if (!res.headersSent) {
          res.status(500).json({
            errors: [
              { message: 'INTERNAL_SERVER_ERROR', extensions: { code: 'INTERNAL_SERVER_ERROR' } },
            ],
          });
        }
      }
    };
  }
}
