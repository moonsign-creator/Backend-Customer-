import { BadRequestException, Controller, Get, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Service } from '@prisma/client';
import { AuthUser, CurrentUser, Public } from '../common/auth';
import { PrismaService } from '../common/prisma.service';
import { SettingsService } from '../common/settings.service';
import { ageFrom, categoriesForAge } from '../common/rules';
import { ProfilesModule, ProfilesService } from '../profiles/profiles.module';
import { COMMON_QUESTIONS, PLACES } from './content';

@ApiTags('catalog')
@Controller('catalog')
class CatalogController {
  constructor(private readonly prisma: PrismaService, private readonly settings: SettingsService, private readonly profiles: ProfilesService) {}

  /** Prices, slabs, minimums and cut-offs the app needs (admin-controlled). */
  @Public()
  @Get('config')
  config() {
    return this.settings.get();
  }

  @Public()
  @ApiQuery({ name: 'service', enum: Service, required: false })
  @Get('practitioners')
  practitioners(@Query('service') service?: Service) {
    return this.prisma.practitioner.findMany({
      where: { active: true, ...(service ? { service } : {}) },
      select: { id: true, code: true, name: true, service: true, gender: true, languages: true, experienceYears: true, rating: true },
      orderBy: { rating: 'desc' },
    });
  }

  /** UC-03 step 4: categories for the chosen profile's age, with common questions. */
  @ApiBearerAuth()
  @Get('categories')
  async categories(@CurrentUser() u: AuthUser, @Query('profileId') profileId: string) {
    if (!profileId) throw new BadRequestException('profileId is required');
    const p = await this.profiles.own(u.sub, profileId);
    const age = ageFrom(p.dob);
    const { list, def } = categoriesForAge(age);
    return { age, default: def, categories: list.map((name) => ({ name, questions: COMMON_QUESTIONS[name] ?? [] })) };
  }

  @Public()
  @Get('places')
  places(@Query('q') q = '') {
    const s = q.trim().toLowerCase();
    return PLACES.filter((p) => !s || p.toLowerCase().includes(s)).slice(0, 10);
  }

  @Public()
  @Get('report-types')
  reportTypes() {
    return this.prisma.reportType.findMany({ where: { active: true }, orderBy: { price: 'asc' } });
  }
}

@Module({ imports: [ProfilesModule], controllers: [CatalogController] })
export class CatalogModule {}
