import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { StoresService } from '../stores/stores.service';

// Guards every /store/* route. JwtAuthGuard runs first so `req.user` is
// populated; then this guard verifies the viewer actually owns at least
// one Store row.
//
// Backwards-compatible escape hatch: if the `STORE_USER_IDS` env var is
// set (comma-separated user IDs) we honour the legacy admin override —
// listed users always pass even if they don't own a store. Useful for
// staging, demos, and CI where you want to exercise the dashboard
// without having to seed real stores first.
@Injectable()
export class StoreGuard implements CanActivate {
  constructor(private stores: StoresService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<{ user?: { userId?: string } }>();
    const userId = req.user?.userId;
    if (!userId) {
      throw new ForbiddenException('يجب تسجيل الدخول كحساب متجر');
    }

    const allowList = (process.env.STORE_USER_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowList.includes(userId)) return true;

    const owned = await this.stores.ownedStoreIds(userId);
    if (owned.length === 0) {
      throw new ForbiddenException('لا يوجد متجر مرتبط بهذا الحساب');
    }
    return true;
  }
}
