import { Global, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationKind } from '@prisma/client';
import { readFileSync } from 'fs';
import * as admin from 'firebase-admin';
import { PrismaService } from '../common/prisma.service';
import { message } from '../common/i18n';

/** Stores in-app notifications and sends FCM pushes in the user's language. */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly log = new Logger('Notifications');
  private fcm?: admin.messaging.Messaging;

  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  onModuleInit() {
    const path = this.config.get<string>('FIREBASE_SERVICE_ACCOUNT_PATH');
    if (!path) return;
    const app = admin.apps.length
      ? admin.app()
      : admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(path, 'utf8'))) });
    this.fcm = app.messaging();
  }

  async notify(userId: string, kind: NotificationKind, key: string, params: Record<string, string | number> = {}, data: Record<string, string> = {}) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { lang: true, fcmTokens: true } });
    if (!user) return;
    const { title, body } = message(key, user.lang, params);
    const n = await this.prisma.notification.create({ data: { userId, kind, title, body } });
    await this.push(userId, user.fcmTokens, title, body, { kind, notificationId: n.id, ...data });
    return n;
  }

  private async push(userId: string, tokens: string[], title: string, body: string, data: Record<string, string>) {
    if (!tokens.length) return;
    if (!this.fcm) {
      this.log.debug(`[push:dev] ${userId}: ${title} - ${body}`);
      return;
    }
    try {
      const res = await this.fcm.sendEachForMulticast({ tokens, notification: { title, body }, data });
      const dead = res.responses
        .map((r, i) => (!r.success && r.error?.code === 'messaging/registration-token-not-registered' ? tokens[i] : null))
        .filter((t): t is string => !!t);
      if (dead.length) {
        await this.prisma.user.update({ where: { id: userId }, data: { fcmTokens: tokens.filter((t) => !dead.includes(t)) } });
      }
    } catch (e) {
      this.log.warn(`FCM send failed: ${(e as Error).message}`);
    }
  }

  list(userId: string, take = 50) {
    return this.prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take });
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({ where: { userId, read: false }, data: { read: true } });
    return { ok: true };
  }
}
