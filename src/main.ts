import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './redis-io.adapter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const raw = process.env.CORS_ORIGINS ?? '*';
  const origins: string[] | true = raw === '*' ? true : raw.split(',').map((s) => s.trim());

  if (process.env.TRUST_PROXY) app.getHttpAdapter().getInstance().set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
  app.use(helmet());
  app.enableCors({ origin: origins, credentials: true });
  app.setGlobalPrefix('v1', { exclude: ['health'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();

  const io = new RedisIoAdapter(app, process.env.REDIS_URL ?? 'redis://localhost:6379', origins);
  await io.connect();
  app.useWebSocketAdapter(io);

  const doc = new DocumentBuilder()
    .setTitle('NamyaAstro Customer API')
    .setDescription('REST API for the customer app. Real-time events: Socket.IO namespace /rt (see README).')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc));

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  Logger.log(`API on http://localhost:${port}/v1 · docs on /docs · socket on /rt`, 'Bootstrap');
}
bootstrap();
