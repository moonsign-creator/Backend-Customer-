import { BadRequestException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { AuthUser } from '../common/auth';
import { OtpProvider } from './otp.provider';

const OTP_TTL_SEC = 300;
const RESEND_AFTER_SEC = 30; // UC-01: resend allowed after 30 s
const MAX_ATTEMPTS = 3; // UC-01: 3 wrong attempts, then a new OTP is needed
const MAX_SENDS_PER_HOUR = 5;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly otp: OtpProvider,
  ) {}

  async requestOtp(phone: string) {
    const r = this.redis.client;
    const key = `otp:${phone}`;
    const existing = await r.hgetall(key);
    if (existing.sentAt) {
      const wait = RESEND_AFTER_SEC - Math.floor((Date.now() - Number(existing.sentAt)) / 1000);
      if (wait > 0) throw new HttpException({ message: `Please wait ${wait}s before requesting a new OTP`, retryAfterSec: wait }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const sends = await r.incr(`otp-sends:${phone}`);
    if (sends === 1) await r.expire(`otp-sends:${phone}`, 3600);
    if (sends > MAX_SENDS_PER_HOUR) throw new HttpException('Too many OTP requests. Try again later.', HttpStatus.TOO_MANY_REQUESTS);

    const code = this.otp.generate();
    await r.multi().del(key).hset(key, { hash: sha(`${phone}:${code}`), attempts: 0, sentAt: Date.now() }).expire(key, OTP_TTL_SEC).exec();
    await this.otp.send(phone, code);
    return { sent: true, resendAfterSec: RESEND_AFTER_SEC, expiresInSec: OTP_TTL_SEC, attemptsAllowed: MAX_ATTEMPTS };
  }

  async verifyOtp(phone: string, code: string, lang?: 'en' | 'hi') {
    const r = this.redis.client;
    const key = `otp:${phone}`;
    const rec = await r.hgetall(key);
    if (!rec.hash) throw new BadRequestException('OTP expired. Please request a new one.');
    if (Number(rec.attempts) >= MAX_ATTEMPTS) throw new BadRequestException('Too many wrong attempts. Please request a new OTP.');
    const ok = timingSafeEqual(Buffer.from(rec.hash), Buffer.from(sha(`${phone}:${code}`)));
    if (!ok) {
      const attempts = await r.hincrby(key, 'attempts', 1);
      throw new BadRequestException({ message: 'Incorrect OTP', attemptsLeft: Math.max(0, MAX_ATTEMPTS - attempts) });
    }
    await r.del(key);

    let user = await this.prisma.user.findUnique({ where: { phone } });
    const isNew = !user;
    if (!user) {
      user = await this.prisma.user.create({ data: { phone, lang: lang ?? 'en', wallet: { create: {} } } });
    }
    const profiles = await this.prisma.profile.count({ where: { userId: user.id, deletedAt: null } });
    return { ...(await this.issueTokens(user.id, phone)), isNewUser: isNew, needsProfile: profiles === 0, user };
  }

  async refresh(refreshToken: string) {
    const rec = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha(refreshToken) }, include: { user: true } });
    if (!rec || rec.revokedAt || rec.expiresAt < new Date()) throw new UnauthorizedException('Refresh token invalid');
    // Rotate: the old token can be used only once.
    await this.prisma.refreshToken.update({ where: { id: rec.id }, data: { revokedAt: new Date() } });
    return this.issueTokens(rec.userId, rec.user.phone);
  }

  async logout(refreshToken: string) {
    await this.prisma.refreshToken.updateMany({ where: { tokenHash: sha(refreshToken), revokedAt: null }, data: { revokedAt: new Date() } });
    return { ok: true };
  }

  private async issueTokens(userId: string, phone: string) {
    const payload: AuthUser = { sub: userId, role: 'customer', phone };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow('JWT_ACCESS_SECRET'),
      expiresIn: this.config.get('JWT_ACCESS_TTL', '15m'),
    });
    const refreshToken = randomBytes(48).toString('base64url');
    const days = Number(this.config.get('JWT_REFRESH_TTL_DAYS', 30));
    await this.prisma.refreshToken.create({
      data: { userId, tokenHash: sha(refreshToken), expiresAt: new Date(Date.now() + days * 86400_000) },
    });
    return { accessToken, refreshToken };
  }
}
