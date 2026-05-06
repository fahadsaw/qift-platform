import {
  Body,
  Controller,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ReportsService, type ReportInput } from './reports.service';
import { JwtAuthGuard } from '../auth/jwt.guard';

type AuthedRequest = { user: { userId: string; qiftUsername: string } };

// Reports controller is write-only from the user surface. The admin
// queue (GET /reports) is intentionally NOT exposed here — it'll
// belong on a separate admin-guarded module when the moderation tool
// is built. Filtering reports out by visibility / role is a follow-up.
@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private service: ReportsService) {}

  // POST /reports — file a report.
  // Body: { reportedUserId, reason, details? }.
  // Reporter is the JWT viewer — never accepted from the body.
  @Post()
  create(@Body() body: ReportInput, @Req() req: AuthedRequest) {
    return this.service.create(req.user.userId, body);
  }
}
