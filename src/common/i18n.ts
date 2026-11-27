import { Lang } from '@prisma/client';

// Server-generated text (notifications, push) in English and Hindi.
type Params = Record<string, string | number>;
type Tpl = { title: string; body: string };

const T: Record<string, Record<Lang, Tpl>> = {
  booking_confirmed: {
    en: { title: 'Booking confirmed', body: '{mode} consultation for {name}, {when}.' },
    hi: { title: 'बुकिंग की पुष्टि हुई', body: '{name} के लिए {mode} परामर्श, {when}।' },
  },
  booking_rescheduled: {
    en: { title: 'Booking rescheduled', body: 'Your consultation is now on {when}. The old slot has been released.' },
    hi: { title: 'बुकिंग का समय बदला गया', body: 'आपका परामर्श अब {when} को है। पुराना स्लॉट छोड़ दिया गया है।' },
  },
  preread_started: {
    en: { title: 'Your astrologer is preparing', body: '{practitioner} is reading the chart for {name}. Please be ready to join in {min} minutes.' },
    hi: { title: 'आपके ज्योतिषी तैयारी कर रहे हैं', body: '{practitioner} {name} की कुंडली देख रहे हैं। कृपया {min} मिनट में जुड़ने के लिए तैयार रहें।' },
  },
  practitioner_ready: {
    en: { title: 'Your astrologer is ready', body: 'Join now. If you do not join within {grace} minutes, a no-show charge applies.' },
    hi: { title: 'आपके ज्योतिषी तैयार हैं', body: 'अभी जुड़ें। {grace} मिनट में न जुड़ने पर नो-शो शुल्क लगेगा।' },
  },
  session_completed: {
    en: { title: 'Session completed', body: 'Duration {min} min · ₹{charged} charged.{extra}' },
    hi: { title: 'सत्र पूरा हुआ', body: 'अवधि {min} मिनट · ₹{charged} काटे गए।{extra}' },
  },
  no_show: {
    en: { title: 'Session marked as no-show', body: '{name} did not join within the grace period. A no-show charge of ₹{amount} was deducted. Please make a fresh booking to continue the discussion.' },
    hi: { title: 'सत्र नो-शो माना गया', body: '{name} समय पर नहीं जुड़े। ₹{amount} का नो-शो शुल्क काटा गया। चर्चा जारी रखने के लिए नई बुकिंग करें।' },
  },
  money_added: {
    en: { title: 'Money added', body: '₹{amount} added to your wallet.' },
    hi: { title: 'पैसे जोड़े गए', body: '₹{amount} आपके वॉलेट में जोड़े गए।' },
  },
  payment_failed: {
    en: { title: 'Payment failed', body: 'Your payment of ₹{amount} did not go through. No money was taken.' },
    hi: { title: 'भुगतान विफल', body: '₹{amount} का भुगतान नहीं हो सका। कोई पैसा नहीं कटा।' },
  },
  report_ordered: {
    en: { title: 'Report ordered', body: '{report} for {name}. We will notify you when it is ready.' },
    hi: { title: 'रिपोर्ट ऑर्डर हुई', body: '{name} के लिए {report}। तैयार होने पर हम आपको सूचित करेंगे।' },
  },
  report_ready: {
    en: { title: 'Your report is ready', body: '{report} for {name} is ready to read.' },
    hi: { title: 'आपकी रिपोर्ट तैयार है', body: '{name} की {report} पढ़ने के लिए तैयार है।' },
  },
  tarot_matched: {
    en: { title: 'Your tarot reader is ready', body: '{practitioner} is ready for your reading. Join now.' },
    hi: { title: 'आपका टैरो रीडर तैयार है', body: '{practitioner} आपकी रीडिंग के लिए तैयार हैं। अभी जुड़ें।' },
  },
  tarot_optout: {
    en: { title: 'We will let you know', body: 'You left the tarot waiting room. We will notify you once a day when readers are available.' },
    hi: { title: 'हम आपको बताएंगे', body: 'आपने टैरो प्रतीक्षा कक्ष छोड़ दिया। रीडर उपलब्ध होने पर हम दिन में एक बार सूचित करेंगे।' },
  },
  tarot_reminder: {
    en: { title: 'Tarot readers are online', body: '{count} readers are available now. Get your reading without waiting.' },
    hi: { title: 'टैरो रीडर ऑनलाइन हैं', body: 'अभी {count} रीडर उपलब्ध हैं। बिना इंतज़ार के रीडिंग लें।' },
  },
  ticket_created: {
    en: { title: 'Support request received', body: 'We have received "{subject}". Our team will reply soon.' },
    hi: { title: 'सहायता अनुरोध मिला', body: 'हमें "{subject}" मिल गया है। हमारी टीम जल्द जवाब देगी।' },
  },
};

const fill = (s: string, p: Params) => s.replace(/\{(\w+)\}/g, (_, k) => String(p[k] ?? ''));

export function message(key: keyof typeof T | string, lang: Lang, params: Params = {}): Tpl {
  const tpl = T[key]?.[lang] ?? T[key]?.en;
  if (!tpl) return { title: key, body: '' };
  return { title: fill(tpl.title, params), body: fill(tpl.body, params) };
}

/** "Today at 4:00 PM" style IST formatting for notifications. */
export function fmtWhen(d: Date, lang: Lang) {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  };
  return d.toLocaleString(lang === 'hi' ? 'hi-IN' : 'en-IN', opts);
}
