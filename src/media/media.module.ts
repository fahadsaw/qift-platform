import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';

// MediaModule owns the R2/S3 client and the multipart upload routes.
// We export MediaService so future modules (posts, gifts, store
// images) can `imports: [MediaModule]` and reuse `uploadBuffer`
// without spinning up their own S3 client.
@Module({
  controllers: [MediaController],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
