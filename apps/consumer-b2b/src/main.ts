import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConsumerModule, loadConsumerConfig } from '@pubsub/consumer-kit';

async function bootstrap(): Promise<void> {
  const config = loadConsumerConfig('b2b');
  const app = await NestFactory.create(ConsumerModule.forRoot(config));
  app.enableCors();
  app.enableShutdownHooks();
  await app.listen(config.port);

  new Logger('consumer-b2b').log(
    `http://localhost:${config.port} · channel=${config.channel} · schema=${config.schema}`,
  );
}

void bootstrap();
