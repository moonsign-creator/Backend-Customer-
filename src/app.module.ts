import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { JwtAuthGuard, Public } from './common/auth';
import { PrismaModule, PrismaService } from './common/prisma.service';
import { RedisModule, RedisService } from './common/redis.service';
import { SettingsModule } from './common/settings.service';
import { AuthModule } from './auth/auth.module';
import { BookingsModule } from './bookings/bookings.module';
import { CatalogModule } from './catalog/catalog.module';
import { DevModule } from './dev/dev.module';
import { HoroscopeModule } from './horoscope/horoscope.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ProfilesModule } from './profiles/profiles.module';
import { ReportsModule } from './reports/reports.module';
import { LiveModule } from './sessions/live.module';
import { RealtimeModule } from './sessions/realtime.events';
import { SupportModule } from './support/support.module';
import { UsersModule } from './users/users.module';
import { WalletModule } from './wallet/wallet.module';

@Controller('health')
class HealthController {
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService) {}

  @Public()
  @Get()
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    await this.redis.client.ping();
    return { ok: true, time: new Date().toISOString() };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    JwtModule.register({ global: true }),
    ScheduleModule.forRoot(),
    // Per-IP limits. Per-phone OTP limits live in AuthService. Set TRUST_PROXY behind a load balancer.
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 300 }], skipIf: () => process.env.THROTTLE_DISABLED === 'true' }),
    PrismaModule,
    RedisModule,
    SettingsModule,
    RealtimeModule,
    NotificationsModule,
    AuthModule,
    UsersModule,
    ProfilesModule,
    CatalogModule,
    WalletModule,
    BookingsModule,
    LiveModule,
    ReportsModule,
    SupportModule,
    HoroscopeModule,
    DevModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
