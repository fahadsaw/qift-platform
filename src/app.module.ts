import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { SocialAccountsModule } from './social-accounts/social-accounts.module';
import { AddressesModule } from './addresses/addresses.module';
import { GiftsModule } from './gifts/gifts.module';
import { AuthModule } from './auth/auth.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';
import { OtpModule } from './otp/otp.module';
import { NotificationsModule } from './notifications/notifications.module';
import { StoreModule } from './store/store.module';
import { StoresModule } from './stores/stores.module';
import { ProductsModule } from './products/products.module';
import { StoreIntegrationsModule } from './store-integrations/store-integrations.module';
import { PushModule } from './push/push.module';
import { FollowsModule } from './follows/follows.module';
import { WishesModule } from './wishes/wishes.module';
import { BlocksModule } from './blocks/blocks.module';
import { ReportsModule } from './reports/reports.module';
import { MediaModule } from './media/media.module';
// Note: the generic `PostsModule` (media-upload posts) was retired
// in the dormant-generic-posting cleanup. Gift posts have their own
// `GiftPostsModule` below; the legacy `Post` table is kept in the
// database for now (data preservation), with a future migration
// task to drop it once historical data is reviewed.
import { GiftPostsModule } from './gift-posts/gift-posts.module';
import { OccasionsModule } from './occasions/occasions.module';
import { AdminModule } from './admin/admin.module';
import { MailModule } from './mail/mail.module';
import { InvitesModule } from './invites/invites.module';
import { BetaAccessModule } from './beta-access/beta-access.module';
import { CorporateModule } from './corporate/corporate.module';
import { FinancialLedgerModule } from './financial/financial-ledger.module';

@Module({
  imports: [
    // Global DB client: one PrismaService (and one connection pool)
    // for the whole app. Imported once here; every feature module
    // resolves the same instance without providing it locally.
    PrismaModule,
    UsersModule,
    SocialAccountsModule,
    AddressesModule,
    GiftsModule,
    AuthModule,
    OrdersModule,
    PaymentsModule,
    OtpModule,
    NotificationsModule,
    StoreModule,
    StoresModule,
    ProductsModule,
    StoreIntegrationsModule,
    PushModule,
    FollowsModule,
    WishesModule,
    BlocksModule,
    ReportsModule,
    MediaModule,
    GiftPostsModule,
    OccasionsModule,
    AdminModule,
    MailModule,
    InvitesModule,
    BetaAccessModule,
    CorporateModule,
    // Financial ledger substrate (PR 2). Dark-launched: the service is
    // available for injection but no producer writes to it yet.
    FinancialLedgerModule,
  ],
  // UsersController + UsersService now live inside UsersModule —
  // imported above. Registering them here would create a duplicate
  // controller binding and a duplicate service instance. AppController
  // (the / and /health routes) stays here because there's no
  // dedicated module for it.
  // AppController serves only the root + /health routes and needs no
  // provider (it deliberately does not touch Prisma). The DB client is
  // supplied globally by PrismaModule above.
  controllers: [AppController],
})
export class AppModule {}
