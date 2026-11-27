import { Controller, Get, Module, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Profile } from '@prisma/client';
import { AuthUser, CurrentUser } from '../common/auth';
import { PrismaService } from '../common/prisma.service';
import { personalDay } from '../common/rules';
import { istDay } from '../common/time';
import { DAILY_LINES, PERSONAL_DAY_MEANING, SIGNS, SIGNS_HI, WEEKLY_HOROSCOPE } from '../catalog/content';
import { ProfilesModule, ProfilesService } from '../profiles/profiles.module';

/**
 * Placeholder moon sign, same as the app. Replace with an ephemeris service
 * (e.g. Swiss Ephemeris) using full birth date, time and place.
 */
function moonSignIndex(p: Pick<Profile, 'dob' | 'tob'>) {
  const d = new Date(`${p.dob}T${p.tob || '12:00'}`);
  return Math.abs(Math.floor(d.getTime() / (2.3 * 86400000))) % 12;
}

@ApiTags('horoscope')
@ApiBearerAuth()
@Controller('horoscope')
class HoroscopeController {
  constructor(private readonly profiles: ProfilesService, private readonly prisma: PrismaService) {}

  /** UC-10 home card: daily (by moon sign), weekly, and numerology Personal Day for a profile. */
  @Get(':profileId')
  async forProfile(@CurrentUser() u: AuthUser, @Param('profileId', ParseUUIDPipe) profileId: string) {
    const p = await this.profiles.own(u.sub, profileId);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: u.sub }, select: { lang: true } });
    const idx = moonSignIndex(p);
    const today = new Date(`${istDay(Date.now())}T00:00:00`);
    const pd = personalDay(p.dob, today);
    return {
      date: istDay(Date.now()),
      moonSign: { index: idx, name: SIGNS[idx], nameHi: SIGNS_HI[idx], label: user.lang === 'hi' ? SIGNS_HI[idx] : SIGNS[idx] },
      daily: DAILY_LINES[(idx + today.getDate()) % DAILY_LINES.length],
      weekly: WEEKLY_HOROSCOPE,
      numerology: { personalYear: pd.py, personalMonth: pd.pm, personalDay: pd.pd, ...PERSONAL_DAY_MEANING[pd.pd] },
    };
  }
}

@Module({ imports: [ProfilesModule], controllers: [HoroscopeController] })
export class HoroscopeModule {}
