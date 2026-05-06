import { Module } from '@nestjs/common';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { PrismaService } from '../prisma/prisma.service';
import { MediaModule } from '../media/media.module';

// PostsModule depends on MediaModule for R2 uploads. We import (not
// re-provide) so PostsService and any future consumer share the same
// MediaService instance and the S3 client only initializes once per
// app process.
@Module({
  imports: [MediaModule],
  controllers: [PostsController],
  providers: [PostsService, PrismaService],
  exports: [PostsService],
})
export class PostsModule {}
