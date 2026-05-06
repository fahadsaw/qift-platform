import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Allow-list of reasons. Frontend renders a radio group from this set;
// backend rejects anything outside it so a malicious client can't
// spam arbitrary strings into the admin queue.
const REASONS = new Set([
  'spam',
  'harassment',
  'impersonation',
  'inappropriate_content',
  'other',
]);

const DETAILS_MAX = 1000;

export type ReportInput = {
  reportedUserId?: string;
  reason?: string;
  details?: string;
};

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  // POST /reports — file a report against a user. The reporter is the
  // JWT viewer (controller layer); only the target + reason + optional
  // details come from the body.
  //
  // Self-reporting is rejected at 400 — there's no use case. Reporting
  // a deleted user is a 404. Beyond that the row is created and
  // surfaces on the admin queue. Filing the same report twice is
  // allowed (no @@unique) — operators sometimes want to know about
  // repeat-offending content from the same reporter.
  async create(reporterId: string, body: ReportInput) {
    const reportedUserId = body.reportedUserId?.trim();
    const reason = body.reason?.trim().toLowerCase() ?? '';
    const rawDetails = body.details?.trim() ?? '';

    if (!reportedUserId) {
      throw new BadRequestException('reported_user_required');
    }
    if (reportedUserId === reporterId) {
      throw new BadRequestException('cannot_report_self');
    }
    if (!REASONS.has(reason)) {
      throw new BadRequestException('reason_invalid');
    }
    if (rawDetails.length > DETAILS_MAX) {
      throw new BadRequestException(
        `details must be at most ${DETAILS_MAX} chars`,
      );
    }

    const target = await this.prisma.user.findUnique({
      where: { id: reportedUserId },
      select: { id: true, deletedAt: true },
    });
    if (!target || target.deletedAt) {
      throw new NotFoundException('user_not_found');
    }

    return this.prisma.report.create({
      data: {
        reporterId,
        reportedUserId,
        reason,
        details: rawDetails || null,
      },
      select: {
        id: true,
        reason: true,
        status: true,
        createdAt: true,
      },
    });
  }
}
