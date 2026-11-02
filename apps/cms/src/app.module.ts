import { Module } from '@nestjs/common';
import { AdminModule } from './admin/admin.controller';
import { ConfigModule } from './config.module';
import { DatabaseModule } from './db/database.module';
import { Migrator } from './db/migrator';
import { EntitiesModule } from './entities/entity-writer';
import { GraphqlModule } from './graphql/graphql.module';
import { ChangesModule } from './read/changes-reader';
import { SyncModule } from './sync/sync.module';
import { ViewReader } from './read/view-reader';

@Module({
  imports: [ConfigModule, DatabaseModule, EntitiesModule, ChangesModule, SyncModule, GraphqlModule, AdminModule],
  providers: [Migrator, ViewReader],
})
export class AppModule {}
