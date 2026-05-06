import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PostsService } from './posts.service';

type AuthedRequest = { user: { userId: string; qiftUsername: string } };

// 50 MB ceiling at the multer layer matches the video cap. Photos
// hit a stricter 8 MB ceiling inside PostsService.
const MULTER_MAX_BYTES = 50 * 1024 * 1024;

@Controller('posts')
@UseGuards(JwtAuthGuard)
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  // POST /posts — multipart/form-data with `file` (required) and an
  // optional `caption` text part. Returns the new post row.
  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MULTER_MAX_BYTES, files: 1 },
    }),
  )
  async create(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { caption?: string | null },
    @Req() req: AuthedRequest,
  ) {
    if (!file) {
      throw new BadRequestException('Missing file field "file".');
    }
    return this.posts.createPost({
      userId: req.user.userId,
      file,
      caption: body?.caption ?? null,
    });
  }

  // GET /posts/me — owner view, includes private posts when those
  // ship later. Today every post is public, so this is the same data
  // shape as the per-user listing — but we keep the dedicated route
  // so the frontend doesn't need to know its own userId to load.
  @Get('me')
  listMine(@Req() req: AuthedRequest) {
    return this.posts.listMyPosts(req.user.userId);
  }

  // DELETE /posts/:id — owner-only.
  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.posts.deletePost(req.user.userId, id);
  }
}
