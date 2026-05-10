import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PrismaService } from '../prisma/prisma.service';
import { MediaService } from './media.service';

type AuthedRequest = { user: { userId: string; qiftUsername: string } };

// Hard caps. Mirror the frontend's preflight check so honest clients
// don't bother POSTing oversized payloads, but never trust the client
// — we re-validate here and Multer will already have rejected
// anything > the larger ceiling at parse time.
const MAX_PHOTO_BYTES = 8 * 1024 * 1024; // 8 MB — same ceiling as posts.
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50 MB — short reveal clips.
const ALLOWED_PHOTO_MIME = /^image\/(png|jpe?g|gif|webp|heic|heif|avif)$/i;
const ALLOWED_VIDEO_MIME = /^video\/(mp4|webm|quicktime)$/i;
// Avatar endpoint stays photo-only — we don't surface video avatars.
const ALLOWED_MIME = ALLOWED_PHOTO_MIME;
const MAX_BYTES = MAX_PHOTO_BYTES;

@Controller('media')
@UseGuards(JwtAuthGuard)
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly prisma: PrismaService,
  ) {}

  // POST /media/avatar — multipart/form-data with a single `file` part.
  //
  // Flow:
  //   1. Multer parses the multipart payload up to MAX_BYTES.
  //   2. We re-validate mime + non-empty buffer (Multer's own filter
  //      runs early and is fine for size, but we re-check mime so a
  //      caller can't smuggle in a non-image with a doctored content
  //      type by also failing the regex here).
  //   3. MediaService writes to R2 under `avatars/<userId>/...`.
  //   4. We patch User.avatarUrl to the returned public URL and
  //      return it to the client.
  //
  // The endpoint is JWT-guarded and the userId is taken from the
  // token, never the body — preventing avatar-hijack across users
  // even if someone reverse-engineered the keying scheme.
  @Post('avatar')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_BYTES, files: 1 },
    }),
  )
  async uploadAvatar(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: AuthedRequest,
  ): Promise<{ avatarUrl: string }> {
    if (!file) {
      throw new BadRequestException('Missing file field "file".');
    }
    if (!file.mimetype || !ALLOWED_MIME.test(file.mimetype)) {
      throw new BadRequestException(
        'Unsupported image type. Use PNG, JPEG, GIF, WebP, HEIC, or AVIF.',
      );
    }
    if (!file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('Empty file.');
    }
    if (file.buffer.length > MAX_BYTES) {
      throw new BadRequestException('Image too large (max 8 MB).');
    }

    const { url } = await this.media.uploadBuffer({
      keyPrefix: `avatars/${req.user.userId}`,
      originalName: file.originalname || 'avatar',
      contentType: file.mimetype,
      body: file.buffer,
    });

    // Persist on the User row. We let the URL field own the source of
    // truth; the next /users/me load will surface the new value to
    // every connected device. Length cap matches users.service's
    // 1024-char ceiling for `avatarUrl`.
    if (url.length > 1024) {
      throw new BadRequestException(
        'Public URL exceeds 1024 chars; check R2_PUBLIC_BASE_URL.',
      );
    }
    await this.prisma.user.update({
      where: { id: req.user.userId },
      data: { avatarUrl: url },
    });

    return { avatarUrl: url };
  }

  // POST /media/gift — multipart/form-data with a single `file` part.
  //
  // Accepts an image OR a short video. Returns the public URL plus a
  // `mediaType` discriminator ('image' | 'video') so the gift-create
  // call can pass both to /gifts without the client having to inspect
  // the mime type itself.
  //
  // Storage path is `gifts/<userId>/...` so an account-deletion sweep
  // can wildcard-purge a user's gift media without touching avatars
  // or posts. The object is publicly readable on R2 — privacy lives
  // at the API layer (the gift-visibility module strips `mediaUrl`
  // from the receiver's view until status === 'delivered'). The R2
  // URL itself is unguessable (timestamp + randomBytes(4) in the
  // key) so the unauthenticated public origin is fine.
  //
  // We deliberately do NOT mutate any DB row here — the caller owns
  // the gift create and binds (mediaUrl, mediaType) to the Gift row
  // in the same /gifts request. Decoupling means an upload that
  // succeeds but is then abandoned (user closed the tab between
  // upload + submit) only burns an R2 object, not a half-formed
  // gift.
  @Post('gift')
  @UseInterceptors(
    FileInterceptor('file', {
      // Multer's outer ceiling is the larger of the two so video
      // payloads get past it; the per-mime check below enforces the
      // smaller photo cap.
      limits: { fileSize: MAX_VIDEO_BYTES, files: 1 },
    }),
  )
  async uploadGift(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: AuthedRequest,
  ): Promise<{ url: string; mediaType: 'image' | 'video' }> {
    if (!file) {
      throw new BadRequestException('Missing file field "file".');
    }
    if (!file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('Empty file.');
    }

    const isPhoto = ALLOWED_PHOTO_MIME.test(file.mimetype || '');
    const isVideo = ALLOWED_VIDEO_MIME.test(file.mimetype || '');
    if (!isPhoto && !isVideo) {
      throw new BadRequestException(
        'Unsupported media type. Use a photo (PNG/JPEG/GIF/WebP/HEIC/AVIF) or a short video (MP4/WebM/MOV).',
      );
    }
    const cap = isPhoto ? MAX_PHOTO_BYTES : MAX_VIDEO_BYTES;
    if (file.buffer.length > cap) {
      throw new BadRequestException(
        isPhoto
          ? 'Photo too large (max 8 MB).'
          : 'Video too large (max 50 MB).',
      );
    }

    const { url } = await this.media.uploadBuffer({
      keyPrefix: `gifts/${req.user.userId}`,
      originalName:
        file.originalname || (isPhoto ? 'gift-photo' : 'gift-video'),
      contentType: file.mimetype,
      body: file.buffer,
    });

    if (url.length > 1024) {
      // Mirrors the avatar-side guard — Gift.mediaUrl is a String
      // column without a hard cap on the schema, but downstream
      // consumers (notifications, share sheets) all assume reasonable
      // URL lengths. Refuse anything pathological at the API edge.
      throw new BadRequestException(
        'Public URL exceeds 1024 chars; check R2_PUBLIC_BASE_URL.',
      );
    }

    return { url, mediaType: isPhoto ? 'image' : 'video' };
  }

  // POST /media/store-document — multipart/form-data with `file` +
  // `storeId` + `type` form fields.
  //
  // Used by the merchant onboarding form to upload verification
  // docs (CR scan, VAT cert, license, owner ID, etc.). Each upload:
  //   1. Multer parses the multipart payload up to the document
  //      ceiling (15 MB — bigger than photos because legal PDFs
  //      are routinely 5–10 MB scans, smaller than videos because
  //      we never expect motion in a doc).
  //   2. Re-validate mime against the doc allow-list (PDF + the
  //      same image set we accept on avatars).
  //   3. Verify the caller owns the target Store (or is in the
  //      STORE_USER_IDS env override list).
  //   4. Upload to R2 under `store-docs/<storeId>/...` so an
  //      account-deletion sweep can wildcard-purge a store's
  //      documents.
  //   5. Persist a StoreDocument row pointing at the public URL
  //      so the admin review modal can list every doc for the
  //      store at once.
  //
  // Privacy: the R2 key uses an unguessable timestamp+random
  // suffix (same convention as gift media), but documents
  // CONTAIN sensitive business data (CR numbers, IDs). The list
  // endpoint is gated to admins + the owner; the public storefront
  // never references these URLs.
  @Post('store-document')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 15 * 1024 * 1024, files: 1 },
    }),
  )
  async uploadStoreDocument(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { storeId?: string; type?: string; fileName?: string },
    @Req() req: AuthedRequest,
  ): Promise<{
    id: string;
    type: string;
    fileUrl: string;
    fileName: string | null;
    contentType: string | null;
    uploadedAt: Date;
  }> {
    if (!file) throw new BadRequestException('Missing file field "file".');
    if (!body?.storeId)
      throw new BadRequestException('Missing storeId in form data.');
    if (!body?.type)
      throw new BadRequestException('Missing type in form data.');
    if (!ALLOWED_DOCUMENT_MIME.test(file.mimetype || '')) {
      throw new BadRequestException(
        'Unsupported document type. Use PDF or an image (PNG/JPEG/WebP/HEIC).',
      );
    }
    if (!file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('Empty file.');
    }

    // Ownership / admin check. Mirrors the storeOwner gate used by
    // /stores/:id/owner. STORE_USER_IDS env override passes
    // through (legacy staging admin escape hatch).
    const storeId = body.storeId.trim();
    const allowList = (process.env.STORE_USER_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!allowList.includes(req.user.userId)) {
      const owns = await this.prisma.store.findFirst({
        where: { id: storeId, ownerId: req.user.userId },
        select: { id: true },
      });
      if (!owns) throw new ForbiddenException('Not the store owner.');
    }

    const allowedTypes = new Set([
      'commercial_registration',
      'vat_certificate',
      'business_license',
      'owner_id',
      'other',
    ]);
    const docType = body.type.trim();
    if (!allowedTypes.has(docType)) {
      throw new BadRequestException(`Invalid document type "${docType}".`);
    }

    const { url } = await this.media.uploadBuffer({
      keyPrefix: `store-docs/${storeId}`,
      originalName: file.originalname || `${docType}-doc`,
      contentType: file.mimetype,
      body: file.buffer,
    });

    const created = await this.prisma.storeDocument.create({
      data: {
        storeId,
        type: docType,
        fileUrl: url,
        fileName: body.fileName?.trim() || file.originalname || null,
        contentType: file.mimetype || null,
      },
      select: {
        id: true,
        type: true,
        fileUrl: true,
        fileName: true,
        contentType: true,
        uploadedAt: true,
      },
    });
    return created;
  }

  // GET /media/store-document?storeId= — list every document
  // attached to a store. Same ownership gate as the upload path.
  // Used by the merchant onboarding form (review step) and by the
  // admin review modal (which calls /admin/stores/:id/documents
  // — a thin alias that goes through the same query).
  @Get('store-document')
  async listStoreDocuments(@Req() req: AuthedRequest): Promise<
    Array<{
      id: string;
      type: string;
      fileUrl: string;
      fileName: string | null;
      contentType: string | null;
      uploadedAt: Date;
    }>
  > {
    // Read storeId from query string. We use Express's req.query
    // directly because Nest's @Query decorator wasn't imported in
    // this file historically; importing it triggers a wider
    // refactor we don't need here. Single-param read is safe.
    const reqWithQuery = req as unknown as { query?: { storeId?: string } };
    const storeId = (reqWithQuery.query?.storeId ?? '').trim();
    if (!storeId) throw new BadRequestException('Missing storeId.');

    const allowList = (process.env.STORE_USER_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!allowList.includes(req.user.userId)) {
      const owns = await this.prisma.store.findFirst({
        where: { id: storeId, ownerId: req.user.userId },
        select: { id: true },
      });
      if (!owns) throw new ForbiddenException('Not the store owner.');
    }

    return this.prisma.storeDocument.findMany({
      where: { storeId },
      orderBy: { uploadedAt: 'desc' },
      select: {
        id: true,
        type: true,
        fileUrl: true,
        fileName: true,
        contentType: true,
        uploadedAt: true,
      },
    });
  }

  // DELETE /media/store-document/:id — remove a document. We do NOT
  // delete the underlying R2 object here — keeping the asset means
  // a paranoid admin can still pull the file via the audit logs
  // even after a merchant tried to scrub it. R2 garbage collection
  // is a separate ops sweep keyed on Store.deletedAt + age.
  @Delete('store-document/:id')
  async deleteStoreDocument(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<{ ok: true }> {
    const doc = await this.prisma.storeDocument.findUnique({
      where: { id },
      select: { id: true, storeId: true },
    });
    if (!doc) throw new NotFoundException('Document not found.');

    const allowList = (process.env.STORE_USER_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!allowList.includes(req.user.userId)) {
      const owns = await this.prisma.store.findFirst({
        where: { id: doc.storeId, ownerId: req.user.userId },
        select: { id: true },
      });
      if (!owns) throw new ForbiddenException('Not the store owner.');
    }

    await this.prisma.storeDocument.delete({ where: { id } });
    return { ok: true };
  }
}

// Documents accept PDFs in addition to the standard image set —
// most legal scans are PDF.
const ALLOWED_DOCUMENT_MIME =
  /^(application\/pdf|image\/(png|jpe?g|webp|heic|heif|avif))$/i;
