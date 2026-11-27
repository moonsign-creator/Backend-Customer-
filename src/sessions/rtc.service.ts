import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RtcRole, RtcTokenBuilder } from 'agora-token';

/** Agora RTC tokens for voice consultations. Channel = booking id. */
@Injectable()
export class RtcService {
  constructor(private readonly config: ConfigService) {}

  token(bookingId: string, uid: number, ttlSec = 45 * 60) {
    const appId = this.config.get<string>('AGORA_APP_ID');
    const cert = this.config.get<string>('AGORA_APP_CERTIFICATE');
    const channel = `booking_${bookingId.replace(/-/g, '')}`;
    if (!appId || !cert) return { provider: 'agora', appId: null, channel, uid, token: 'dev-placeholder-token', expiresInSec: ttlSec, mock: true };
    const token = RtcTokenBuilder.buildTokenWithUid(appId, cert, channel, uid, RtcRole.PUBLISHER, ttlSec, ttlSec);
    return { provider: 'agora', appId, channel, uid, token, expiresInSec: ttlSec, mock: false };
  }
}
