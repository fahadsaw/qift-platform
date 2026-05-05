import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

// Cloud-ready bootstrap.
//
// Three things change vs. the local-default Nest scaffold:
//   1. Port comes from `process.env.PORT` (Railway / Render / Fly /
//      Heroku all inject this). Falls back to 4000 for local dev.
//   2. We bind to `0.0.0.0` so the platform's load balancer can reach
//      the process. Listening on the implicit default keeps the socket
//      pinned to localhost on some platforms.
//   3. CORS allow-list is read from `CORS_ORIGINS` (comma-separated).
//      Local dev still works without setting it via the localhost
//      defaults. Prod sets it explicitly to the deployed frontend URL.
//
// Config-only changes — no business behaviour shifted, only the runtime
// surface a deploy target needs.
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  // CORS origins: env-first, with localhost fallbacks so a fresh dev
  // checkout works without copying .env files. Empty entries are
  // dropped so trailing commas don't bite.
  const envOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const localOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
  ];
  // De-dupe in case the env already includes a localhost entry.
  const origins = Array.from(new Set([...envOrigins, ...localOrigins]));
  app.enableCors({
    origin: origins,
    credentials: true,
  });

  // PORT — every PaaS injects this. Default for local dev only.
  const port = Number(process.env.PORT) || 4000;
  // 0.0.0.0 is required by most PaaS load balancers (Railway, Render,
  // Fly). Localhost-only listeners are unreachable from the LB.
  await app.listen(port, '0.0.0.0');

  logger.log(
    `Qift API listening on 0.0.0.0:${port} — CORS origins: ${origins.join(', ')}`,
  );
}

void bootstrap();
