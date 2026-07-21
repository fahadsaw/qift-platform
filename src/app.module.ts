import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';
import { AppController } from './app.controller';
import { DecimalToNumberInterceptor } from './common/decimal-to-number.interceptor';
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
import { SettlementModule } from './settlement/settlement.module';

@Module({
  imports: [
    // Sentry (Track A8). A no-op unless SENTRY_DSN is set (see
    // src/instrument.ts) — safe in dev, CI, and tests.
    SentryModule.forRoot(),
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
    // Track C PR 1 — Settlement Engine Foundation (SC v2.0).
    SettlementModule,
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
  providers: [
    // Track A8: must be the FIRST registered filter. It extends Nest's
    // BaseExceptionFilter — HttpExceptions keep their status codes and
    // bodies exactly as before; only unexpected 5xx errors are ALSO
    // reported to Sentry (when a DSN is configured).
    { provide: APP_FILTER, useClass: SentryGlobalFilter },
    // FIN-3 wire-format guarantee: the financial-record columns are
    // exact NUMERIC (Prisma Decimal) in the DB, but the API keeps
    // returning plain JSON numbers. Registered here (not main.ts) so
    // e2e-booted apps get it too.
    { provide: APP_INTERCEPTOR, useClass: DecimalToNumberInterceptor },
  ],
})
export class AppModule {}
