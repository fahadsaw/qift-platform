import { Module } from '@nestjs/common';
import {
  InvitesController,
  InvitesPublicController,
} from './invites.controller';
import { InvitesService } from './invites.service';

// Invitation MVP module — manual-share only. See
// `project_invitation_architecture.md` for the architectural
// scope + future provider abstractions.
//
// The module registers BOTH the authed controller and the
// public-by-token resolver controller. Splitting them keeps the
// JwtAuthGuard wiring unambiguous at the controller level rather
// than per-route.
@Module({
  controllers: [InvitesController, InvitesPublicController],
  providers: [InvitesService],
  exports: [InvitesService],
})
export class InvitesModule {}
