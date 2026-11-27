import { Body, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Gender, Mode } from '@prisma/client';
import { IsEnum, IsIn, IsUUID } from 'class-validator';
import { AuthUser, CurrentUser } from '../common/auth';
import { PrismaService } from '../common/prisma.service';
import { ProfilesModule } from '../profiles/profiles.module';
import { WalletModule } from '../wallet/wallet.module';
import { TarotService } from '../tarot/tarot.service';
import { RealtimeGateway } from './realtime.gateway';
import { RtcService } from './rtc.service';
import { SessionsScheduler } from './sessions.scheduler';
import { SessionsService } from './sessions.service';

@ApiTags('sessions')
@ApiBearerAuth()
@Controller('sessions')
class SessionsController {
  constructor(private readonly sessions: SessionsService, private readonly rtc: RtcService, private readonly prisma: PrismaService) {}

  /** Current server state of a session (also pushed over the socket as `session:state`). */
  @Get(':id')
  async state(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.sessions.authorize(id, 'customer', u.sub);
    return this.sessions.state(id);
  }

  @Get(':id/messages')
  async messages(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.sessions.authorize(id, 'customer', u.sub);
    return this.prisma.chatMessage.findMany({ where: { bookingId: id }, orderBy: { createdAt: 'asc' } });
  }

  /** Customer ends the session (REST fallback for the socket `session:end`). */
  @Post(':id/end')
  @HttpCode(200)
  async end(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.sessions.authorize(id, 'customer', u.sub);
    return this.sessions.end(id, 'customer');
  }

  /** Agora token for a voice consultation. */
  @Get(':id/rtc-token')
  async rtcToken(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const b = await this.sessions.authorize(id, 'customer', u.sub);
    return this.rtc.token(b.id, 1);
  }
}

class TarotJoinDto {
  @ApiProperty() @IsUUID() profileId: string;
  @ApiProperty({ enum: Mode }) @IsEnum(Mode) mode: Mode;
  @ApiProperty({ enum: ['male', 'female', 'any'] }) @IsIn(['male', 'female', 'any']) gender: Gender | 'any';
}

@ApiTags('tarot')
@ApiBearerAuth()
@Controller('tarot')
class TarotController {
  constructor(private readonly tarot: TarotService) {}

  /** Readers online / available, by gender, and how many are waiting. */
  @Get('summary')
  summary() {
    return this.tarot.summary();
  }

  /** Connect now, or join the waiting room if no reader is free. */
  @Post('queue')
  join(@CurrentUser() u: AuthUser, @Body() dto: TarotJoinDto) {
    return this.tarot.join(u.sub, dto.profileId, dto.mode, dto.gender);
  }

  /** Position and ETA in the waiting room (also pushed as `tarot:queue`). */
  @Get('queue')
  status(@CurrentUser() u: AuthUser) {
    return this.tarot.status(u.sub);
  }

  @Post('queue/leave')
  @HttpCode(200)
  leave(@CurrentUser() u: AuthUser) {
    return this.tarot.leave(u.sub);
  }
}

@Module({
  imports: [ProfilesModule, WalletModule],
  controllers: [SessionsController, TarotController],
  providers: [SessionsService, SessionsScheduler, RtcService, TarotService, RealtimeGateway],
  exports: [SessionsService, TarotService],
})
export class LiveModule {}
