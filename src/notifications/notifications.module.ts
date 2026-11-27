import { Controller, Get, Global, HttpCode, Module, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/auth';
import { NotificationsService } from './notifications.service';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  async list(@CurrentUser() u: AuthUser) {
    const items = await this.svc.list(u.sub);
    return { unread: items.filter((n) => !n.read).length, items };
  }

  @Post('read-all')
  @HttpCode(200)
  readAll(@CurrentUser() u: AuthUser) {
    return this.svc.markAllRead(u.sub);
  }
}

@Global()
@Module({ controllers: [NotificationsController], providers: [NotificationsService], exports: [NotificationsService] })
export class NotificationsModule {}
