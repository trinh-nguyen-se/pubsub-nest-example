import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ZodExceptionFilter } from './common/zod-exception.filter';
import { CONFIG, type AppConfig } from './config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.enableCors();
  app.useGlobalFilters(new ZodExceptionFilter());
  app.enableShutdownHooks();

  const config = app.get<AppConfig>(CONFIG);
  await app.listen(config.port);

  new Logger('CMS').log(
    `http://localhost:${config.port} · fence=${config.fence} · publisher=${config.publishAdapter}`,
  );
}

void bootstrap();
