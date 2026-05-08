import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MediaService } from '../media/media.service';

// Profile-post service — owns the lifecycle of /posts (create, list,
// delete). Media bytes flow through MediaService, so the only thing
// stored in the DB is the resolved public URL + mediaType + caption.

const ALLOWED_PHOTO_MIME = /^image\/(png|jpe?g|gif|webp|heic|heif|avif)$/i;
const ALLOWED_VIDEO_MIME = /^video\/(mp4|webm|quicktime)$/i;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024; // 8 MB — same as avatar.
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50 MB — short profile clips.
const MAX_CAPTION_LEN = 500;

@Injectable()
export class PostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
  ) {}

  // POST /posts — create one post with one media item + optional caption.
  // The controller passes the multer file through; we validate type +
  // size here so the same rules apply if a future endpoint POSTs from
  // elsewhere (e.g. server-side worker uploads).
  async createPost(args: {
    userId: string;
    file: {
      mimetype: string;
      originalname: string;
      buffer: Buffer;
      size: number;
    };
    caption?: string | null;
  }) {
    const { file, userId } = args;
    const isPhoto = ALLOWED_PHOTO_MIME.test(file.mimetype || '');
    const isVideo = ALLOWED_VIDEO_MIME.test(file.mimetype || '');
    if (!isPhoto && !isVideo) {
      throw new BadRequestException(
        'Unsupported media type. Use a photo (PNG/JPEG/GIF/WebP/HEIC/AVIF) or a short video (MP4/WebM/MOV).',
      );
    }
    if (!file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('Empty file.');
    }
    const cap = isPhoto ? MAX_PHOTO_BYTES : MAX_VIDEO_BYTES;
    if (file.buffer.length > cap) {
      throw new BadRequestException(
        isPhoto
          ? 'Photo too large (max 8 MB).'
          : 'Video too large (max 50 MB).',
      );
    }
    const caption = (args.caption ?? '').trim();
    if (caption.length > MAX_CAPTION_LEN) {
      throw new BadRequestException(
        `Caption must be at most ${MAX_CAPTION_LEN} characters.`,
      );
    }

    const { url } = await this.media.uploadBuffer({
      keyPrefix: `posts/${userId}`,
      originalName: file.originalname || (isPhoto ? 'photo' : 'video'),
      contentType: file.mimetype,
      body: file.buffer,
    });

    const post = await this.prisma.post.create({
      data: {
        userId,
        mediaUrl: url,
        mediaType: isPhoto ? 'photo' : 'video',
        caption: caption.length === 0 ? null : caption,
      },
      select: POST_PROJECTION,
    });
    return post;
  }

  // GET /posts/me — owner view of their own feed.
  async listMyPosts(userId: string) {
    return this.prisma.post.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: POST_PROJECTION,
    });
  }

  // GET /users/:userId/posts — public-feed view used by /u/[username].
  // Privacy gating (public / followers / private) lives in the
  // controller layer along with the rest of profile-visibility rules,
  // so this method just returns the rows.
  async listUserPosts(userId: string) {
    return this.prisma.post.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: POST_PROJECTION,
    });
  }

  // DELETE /posts/:id — only the owner can delete. We don't currently
  // delete the R2 object — leaving it makes the URL stable for any
  // cached references and matches how avatars work today. A future
  // sweep job can purge orphans by listing the bucket and diffing
  // against Post.mediaUrl.
  async deletePost(viewerId: string, postId: string) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { id: true, userId: true },
    });
    if (!post) throw new NotFoundException('Post not found');
    if (post.userId !== viewerId) {
      throw new NotFoundException('Post not found');
    }
    await this.prisma.post.delete({ where: { id: postId } });
    return { ok: true };
  }
}

// Stable projection so the controller never accidentally serializes a
// future-added private field.
const POST_PROJECTION = {
  id: true,
  userId: true,
  mediaUrl: true,
  mediaType: true,
  caption: true,
  createdAt: true,
} as const;
