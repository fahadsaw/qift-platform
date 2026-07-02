import { Module } from '@nestjs/common';
import { StoreController } from './store.controller';
import { StoreService } from './store.service';
import { StoreGuard } from './store.guard';
import { NotificationsModule } from '../notifications/notifications.module';
import { StoresModule } from '../stores/stores.module';

// StoresModule (with `s`) is the catalog module — we import it so the
// dashboard guard can ask "does this user own any stores?" and the
// dashboard service can scope its queries to those stores.
@Module({
  imports: [NotificationsModule, StoresModule],
  controllers: [StoreController],
  providers: [StoreService, StoreGuard],
})
export class StoreModule {}
