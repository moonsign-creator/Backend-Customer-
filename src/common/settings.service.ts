import { Global, Injectable, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { BusinessSettings, DEFAULT_SETTINGS } from './rules';

/**
 * Admin-controlled values (UC-33). Defaults match the app; any key stored in the
 * `Setting` table overrides the default. Cached for 30 s so admin edits apply quickly.
 */
@Injectable()
export class SettingsService {
  private cache?: { at: number; value: BusinessSettings };

  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<BusinessSettings> {
    if (this.cache && Date.now() - this.cache.at < 30_000) return this.cache.value;
    const rows = await this.prisma.setting.findMany();
    const value = { ...DEFAULT_SETTINGS } as BusinessSettings;
    for (const r of rows) {
      if (r.key in value) (value as unknown as Record<string, unknown>)[r.key] = r.value;
    }
    this.cache = { at: Date.now(), value };
    return value;
  }
}

@Global()
@Module({ providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}
