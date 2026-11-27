import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Sends the OTP SMS. `console` (dev) logs it; `msg91` uses the MSG91 OTP API. */
@Injectable()
export class OtpProvider {
  private readonly log = new Logger('OTP');
  constructor(private readonly config: ConfigService) {}

  get isConsole() {
    return this.config.get('OTP_PROVIDER', 'console') === 'console';
  }

  /** In console mode the code is fixed to 123456, matching the app's demo. */
  generate() {
    if (this.isConsole) return '123456';
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  async send(phone: string, code: string) {
    if (this.isConsole) {
      this.log.log(`OTP for +91${phone}: ${code}`);
      return;
    }
    const res = await fetch('https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: { authkey: this.config.getOrThrow('MSG91_AUTH_KEY'), 'content-type': 'application/json' },
      body: JSON.stringify({
        template_id: this.config.getOrThrow('MSG91_TEMPLATE_ID'),
        recipients: [{ mobiles: `91${phone}`, otp: code }],
      }),
    });
    if (!res.ok) {
      this.log.error(`MSG91 send failed: ${res.status} ${await res.text()}`);
      throw new Error('Could not send OTP');
    }
  }
}
