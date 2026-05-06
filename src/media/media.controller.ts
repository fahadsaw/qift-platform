import {
  BadRequestException,
  Controller,
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
// anything > MAX_BYTES at parse time.
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const ALLOWED_MIME = /^image\/(png|jpe?g|gif|webp|heic|heif|avif)$/i;

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
}
