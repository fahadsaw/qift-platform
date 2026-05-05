import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SocialAccountsService {
  constructor(private prisma: PrismaService) {}

  create(data: any) {
    return this.prisma.socialAccount.create({
      data: data,
    });
  }

  findAll() {
    return this.prisma.socialAccount.findMany();
  }

  findByUser(userId: string) {
    return this.prisma.socialAccount.findMany({
      where: { userId },
    });
  }
}
