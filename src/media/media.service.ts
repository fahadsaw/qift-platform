import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { randomBytes } from 'node:crypto';

// Reusable media-storage service backed by Cloudflare R2 via the
// S3-compatible API. Used today by avatar uploads; the same upload
// helper will back profile posts, gift media, and store images
// without changes — callers just pass a different `keyPrefix`.
//
// Configuration (Railway env vars):
//   R2_ACCOUNT_ID         — used to build the default endpoint when
//                            R2_ENDPOINT isn't explicitly set
//   R2_ACCESS_KEY_ID      — R2 object-token access key (Object R/W)
//   R2_SECRET_ACCESS_KEY  — R2 object-token secret
//   R2_BUCKET             — bucket name (e.g. `qift-media`)
//   R2_ENDPOINT           — full S3 endpoint (e.g.
//                            https://<account>.r2.cloudflarestorage.com).
//                            Optional; falls back to the
//                            account-default endpoint computed from
//                            R2_ACCOUNT_ID.
//   R2_PUBLIC_BASE_URL    — the public origin where uploaded objects
//                            are served (custom domain or
//                            `pub-<id>.r2.dev` once you flip the
//                            bucket's public-access setting on).
//                            Required to return a usable URL —
//                            without it the bucket stays private and
//                            the API will refuse to upload (we don't
//                            want to silently store objects nobody
//                            can fetch).
//
// Why we don't use presigned PUT URLs from the frontend yet:
//   - keeps R2 secrets fully server-side (req #5 + #7)
//   - lets us enforce mime / size limits in one auditable place
//   - simpler client code — the browser POSTs multipart and we
//     return the public URL it can store on `User.avatarUrl`
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private client: S3Client | null = null;
  private readonly bucket = process.env.R2_BUCKET ?? '';
  private readonly publicBase = (process.env.R2_PUBLIC_BASE_URL ?? '').replace(
    /\/+$/,
    '',
  );

  // Lazy-init the S3 client so a missing-config boot still starts
  // (every other module is independent of media). The first upload
  // attempt is what fails with a 503 if R2 isn't wired.
  private getClient(): S3Client {
    if (this.client) return this.client;
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const endpoint =
      process.env.R2_ENDPOINT ??
      (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');

    if (!this.bucket || !accessKeyId || !secretAccessKey || !endpoint) {
      throw new ServiceUnavailableException(
        'Media storage is not configured. Set R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and either R2_ENDPOINT or R2_ACCOUNT_ID on the API.',
      );
    }
    if (!this.publicBase) {
      throw new ServiceUnavailableException(
        'R2_PUBLIC_BASE_URL is not set. Configure a public domain (custom or `pub-<id>.r2.dev`) so uploaded media can be served.',
      );
    }

    this.client = new S3Client({
      region: 'auto', // R2 ignores region but the SDK insists on something
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      // R2 supports both styles; path-style avoids cert/SNI issues on
      // custom-account endpoints in some clients.
      forcePathStyle: false,
    });
    return this.client;
  }

  // True when the configuration is sufficient to attempt an upload.
  // Useful for /health-style probes; the actual upload paths just
  // throw via getClient() if config is missing.
  isConfigured(): boolean {
    try {
      this.getClient();
      return true;
    } catch {
      return false;
    }
  }

  // Upload an in-memory buffer to R2 and return the public URL.
  //
  // `keyPrefix` is the logical folder ("avatars/<userId>", etc.).
  // The final key is `<keyPrefix>/<timestamp>-<random>-<safeName>`,
  // which gives us:
  //   - human-debuggable paths in the R2 console
  //   - per-user isolation we can later wildcard-delete on account
  //     deletion (see DEPLOYMENT.md tombstone notes)
  //   - collision-proof naming even when two devices race
  async uploadBuffer(args: {
    keyPrefix: string;
    originalName: string;
    contentType: string;
    body: Buffer;
    cacheControl?: string;
  }): Promise<{ key: string; url: string }> {
    const client = this.getClient();
    const safeName = sanitizeFilename(args.originalName);
    const stamp = Date.now();
    const rand = randomBytes(4).toString('hex');
    const key = `${args.keyPrefix.replace(/^\/+|\/+$/g, '')}/${stamp}-${rand}-${safeName}`;

    const params: PutObjectCommandInput = {
      Bucket: this.bucket,
      Key: key,
      Body: args.body,
      ContentType: args.contentType,
      // Avatars and other long-lived media — let CDNs/browsers cache
      // for a year; we use timestamp+random in the key so updates are
      // a new URL, never a stale cache hit.
      CacheControl: args.cacheControl ?? 'public, max-age=31536000, immutable',
    };

    try {
      await client.send(new PutObjectCommand(params));
    } catch (err) {
      this.logger.error(
        `R2 upload failed for ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ServiceUnavailableException(
        'Could not upload to media storage. Try again.',
      );
    }

    return { key, url: `${this.publicBase}/${key}` };
  }
}

// Strip path-y characters and collapse to a safe slug. We keep the
// extension when it's a recognised image type so R2 / browsers serve
// the right Content-Type fallback even when our header is dropped.
function sanitizeFilename(input: string): string {
  const trimmed = (input || '').trim() || 'file';
  // Lowercase, replace any run of non-[a-z0-9.-] with a single dash,
  // collapse leading/trailing dashes, and cap length so our final R2
  // key stays well under common 1024-byte limits.
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'file';
}
