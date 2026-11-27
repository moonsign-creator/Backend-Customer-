import { Body, Controller, Delete, Get, HttpCode, Module, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthUser, CurrentUser } from '../common/auth';
import { PrismaService } from '../common/prisma.service';

class UpdateMeDto {
  @ApiProperty({ required: false, enum: ['en', 'hi'] })
  @IsOptional()
  @IsIn(['en', 'hi'])
  lang?: 'en' | 'hi';

  /** UC-05: consent for sessions to be recorded and stored. */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  recordingConsent?: boolean;
}

class FcmTokenDto {
  @ApiProperty()
  @IsString()
  @MaxLength(4096)
  token: string;
}

@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async me(@CurrentUser() u: AuthUser) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: u.sub },
      select: { id: true, phone: true, lang: true, recordingConsent: true, recordingConsentAt: true, tarotWaitlistOptOutAt: true, createdAt: true, wallet: { select: { balance: true } } },
    });
    const unread = await this.prisma.notification.count({ where: { userId: u.sub, read: false } });
    return { ...user, balance: user.wallet?.balance ?? 0, wallet: undefined, unreadNotifications: unread };
  }

  @Patch()
  update(@CurrentUser() u: AuthUser, @Body() dto: UpdateMeDto) {
    return this.prisma.user.update({
      where: { id: u.sub },
      data: {
        lang: dto.lang,
        recordingConsent: dto.recordingConsent,
        recordingConsentAt: dto.recordingConsent === undefined ? undefined : dto.recordingConsent ? new Date() : null,
      },
      select: { id: true, phone: true, lang: true, recordingConsent: true },
    });
  }

  /** Register this device for push notifications (FCM). */
  @Post('devices')
  @HttpCode(200)
  async addDevice(@CurrentUser() u: AuthUser, @Body() dto: FcmTokenDto) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: u.sub }, select: { fcmTokens: true } });
    const tokens = [dto.token, ...user.fcmTokens.filter((t) => t !== dto.token)].slice(0, 5);
    await this.prisma.user.update({ where: { id: u.sub }, data: { fcmTokens: tokens } });
    return { ok: true };
  }

  @Delete('devices')
  async removeDevice(@CurrentUser() u: AuthUser, @Body() dto: FcmTokenDto) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: u.sub }, select: { fcmTokens: true } });
    await this.prisma.user.update({ where: { id: u.sub }, data: { fcmTokens: user.fcmTokens.filter((t) => t !== dto.token) } });
    return { ok: true };
  }
}

@Module({ controllers: [UsersController] })
export class UsersModule {}
