import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/auth';
import { ProfilesModule } from '../profiles/profiles.module';
import { WalletModule } from '../wallet/wallet.module';
import { CreateBookingDto, RateDto, RescheduleDto, SlotsQuery } from './bookings.dto';
import { BookingsService } from './bookings.service';
import { SlotsService } from './slots.service';

@ApiTags('bookings')
@ApiBearerAuth()
@Controller('bookings')
class BookingsController {
  constructor(private readonly svc: BookingsService, private readonly slots: SlotsService) {}

  /** Hourly slots for the next 24 h; full blocks come back with available=false. */
  @Get('slots')
  getSlots(@Query() q: SlotsQuery) {
    return this.slots.next24h(q.service ?? 'astrology', q.practitionerId);
  }

  /** Whether the profile already has a consultation that day (1 per day per profile). */
  @Get('day-check')
  async dayCheck(@Query('profileId', ParseUUIDPipe) profileId: string, @Query('date') date: string) {
    return { taken: await this.svc.hasConsultationOnDay(profileId, new Date(date || Date.now())) };
  }

  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateBookingDto) {
    return this.svc.create(u.sub, dto);
  }

  @ApiQuery({ name: 'filter', enum: ['upcoming', 'past', 'all'], required: false })
  @ApiQuery({ name: 'profileId', required: false })
  @Get()
  list(@CurrentUser() u: AuthUser, @Query('filter') filter?: 'upcoming' | 'past' | 'all', @Query('profileId') profileId?: string) {
    return this.svc.list(u.sub, filter, profileId);
  }

  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(u.sub, id);
  }

  @Get(':id/reschedule-check')
  check(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.rescheduleCheck(u.sub, id);
  }

  @Post(':id/reschedule')
  reschedule(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RescheduleDto) {
    return this.svc.reschedule(u.sub, id, dto.slotStart);
  }

  @Post(':id/rating')
  rate(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RateDto) {
    return this.svc.rate(u.sub, id, dto.rating, dto.feedback);
  }
}

@ApiTags('history')
@ApiBearerAuth()
@Controller('history')
class HistoryController {
  constructor(private readonly svc: BookingsService) {}

  @ApiQuery({ name: 'profileId', required: false })
  @Get()
  list(@CurrentUser() u: AuthUser, @Query('profileId') profileId?: string) {
    return this.svc.history(u.sub, profileId);
  }

  /** Transcript + remedies for one past session. */
  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.historyItem(u.sub, id);
  }
}

@Module({
  imports: [ProfilesModule, WalletModule],
  controllers: [BookingsController, HistoryController],
  providers: [BookingsService, SlotsService],
  exports: [BookingsService, SlotsService],
})
export class BookingsModule {}
