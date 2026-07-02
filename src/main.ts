import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

// Bump on every CORS / bootstrap change so the Railway log line
// confirms which build is live. Search Railway logs for this string
// after a deploy — if you don't see it, the new build didn't take.
const BOOT_TAG = 'qift-api/cors-v8';

// Always-allowed local dev origins. Matches any port so Next can pick
// 3000/3001/3002 freely without breaking CORS.
const LOCALHOST_REGEX = /^http:\/\/localhost(:\d+)?$/;

// Production origins for qift.net + the www. variant. Hardcoded so a
// missing CORS_ORIGINS env var on Railway doesn't quietly kill the
// app the moment it points at the production domain. Operators can
// still extend the list via CORS_ORIGINS for staging / preview /
// alternate domains.
const PRODUCTION_ORIGINS = new Set([
  'https://qift.net',
  'https://www.qift.net',
]);

// Vercel preview / production aliases for THIS frontend project.
//
// Vercel generates a fresh per-deploy URL on every push (including
// previews from feature branches), and the deletes them when the deploy
// is removed — so pinning a single URL in CORS_ORIGINS leads to
// constant breakage. We instead match the family of URLs that Vercel
// hands out for this project.
//
// Pattern breakdown (anchored both ends, HTTPS-only):
//   ^https:\/\/      → must be HTTPS (no plain-HTTP impostors)
//   qift-ui-v2       → exact project prefix (rename here if the Vercel
//                       project is renamed)
//   [a-z0-9-]*       → optional Vercel-canonical chars only — letters,
//                       digits, hyphens. NO dots, so a hostile origin
//                       like `qift-ui-v2.attacker.vercel.app` does NOT
//                       match.
//   \.vercel\.app$   → must end exactly at .vercel.app
//
// Examples that match:
//   https://qift-ui-v2.vercel.app
//   https://qift-ui-v2-git-main-faahad.vercel.app
//   https://qift-ui-v2-04a3ab46-faahads-projects-0e8d20ec.vercel.app
// Examples that do NOT match:
//   https://qift-ui-v2.attacker.vercel.app  (dot in variable part)
//   https://evil-qift-ui-v2.vercel.app      (wrong prefix)
//   https://qift-ui-v2.vercel.app.evil.com  (anchor at end)
//   http://qift-ui-v2.vercel.app            (HTTP, not HTTPS)
const VERCEL_PROJECT_REGEX = /^https:\/\/qift-ui-v2[a-z0-9-]*\.vercel\.app$/;

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const logger = new Logger('Bootstrap');

  // Listen for termination signals (e.g. a Railway redeploy SIGTERM) so
  // Nest runs lifecycle destroy hooks — notably PrismaService.$disconnect
  // — and the single DB connection pool closes cleanly on shutdown.
  app.enableShutdownHooks();

  app.set('trust proxy', 1);

  const envOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Origin allow-list. Layered so each layer is independently
  // verifiable in the boot log (see the closing logger.log call):
  //   1. No-origin requests (curl, server-to-server, mobile webviews) —
  //      browsers always send Origin, so missing-Origin is not a CORS
  //      attack vector. Allow.
  //   2. Production qift.net domain (hardcoded — survives a missing
  //      CORS_ORIGINS env var).
  //   3. Exact match against CORS_ORIGINS env (operator override for
  //      staging / preview / alternate domains).
  //   4. Localhost regex — local dev convenience.
  //   5. Vercel project regex — covers every preview / production /
  //      branch URL Vercel hands out for this frontend project.
  // Anything else falls through to a logged WARN + a CORS rejection.
  const isAllowedOrigin = (origin: string | undefined): boolean => {
    if (!origin) return true;
    if (PRODUCTION_ORIGINS.has(origin)) return true;
    if (envOrigins.includes(origin)) return true;
    if (LOCALHOST_REGEX.test(origin)) return true;
    if (VERCEL_PROJECT_REGEX.test(origin)) return true;
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
    `[${BOOT_TAG}] listening on 0.0.0.0:${port} — ` +
      `CORS layers: ` +
      `production=[${[...PRODUCTION_ORIGINS].join(', ')}] ` +
      `envOrigins=[${envOrigins.join(', ') || '(none)'}] ` +
      `localhost=${LOCALHOST_REGEX.source} ` +
      `vercelProject=${VERCEL_PROJECT_REGEX.source}`,
  );
}

void bootstrap();
