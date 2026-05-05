import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

const BOOT_TAG = 'qift-api/cors-v2';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const logger = new Logger('Bootstrap');

  app.set('trust proxy', 1);

  const envOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const localhostRegex = /^http:\/\/localhost(:\d+)?$/;

  const isAllowedOrigin = (origin: string | undefined): boolean => {
    if (!origin) return true;
    if (envOrigins.includes(origin)) return true;
    if (localhostRegex.test(origin)) return true;
    return false;
  };

  app.enableCors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }

      logger.warn(`CORS blocked: origin "${origin}" not in allow-list`);
      callback(new Error(`CORS blocked: ${origin}`));
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'Accept-Language',
      'X-Requested-With',
    ],
    maxAge: 86400,
    optionsSuccessStatus: 204,
  });

  const port = Number(process.env.PORT) || 4000;

  await app.listen(port, '0.0.0.0');

  logger.log(
    `[${BOOT_TAG}] listening on 0.0.0.0:${port} — CORS allow-list: ${
      envOrigins.length > 0 ? envOrigins.join(', ') : '(none)'
    }`,
  );
}

void bootstrap();
