// Seeds practitioners and report types matching the app's demo data.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const practitioners = [
    { code: 'a1', name: 'Pt. Raghav Sharma', service: 'astrology', gender: 'male', languages: ['Hindi', 'English'], experienceYears: 18, rating: 4.8 },
    { code: 'a2', name: 'Dr. Meera Iyer', service: 'astrology', gender: 'female', languages: ['English', 'Hindi'], experienceYears: 12, rating: 4.9 },
    { code: 'a3', name: 'Acharya Vinod Joshi', service: 'astrology', gender: 'male', languages: ['Hindi'], experienceYears: 22, rating: 4.7 },
    { code: 't1', name: 'Ananya', service: 'tarot', gender: 'female', languages: ['English', 'Hindi'], experienceYears: 6, rating: 4.8 },
    { code: 't2', name: 'Kabir', service: 'tarot', gender: 'male', languages: ['Hindi', 'English'], experienceYears: 8, rating: 4.6 },
    { code: 't3', name: 'Ishita', service: 'tarot', gender: 'female', languages: ['English'], experienceYears: 4, rating: 4.7 },
  ] as const;
  for (const p of practitioners) {
    await prisma.practitioner.upsert({ where: { code: p.code }, update: {}, create: { ...p, languages: [...p.languages] } });
  }

  const reports = [
    { id: 'r1', name: 'Detailed Kundli Report', nameHi: 'विस्तृत कुंडली रिपोर्ट', description: 'Full birth chart with planetary positions, doshas, dashas and remedies.', price: 999, billing: 'one_time', icon: 'planet' },
    { id: 'r2', name: 'Career & Finance Report', nameHi: 'करियर और वित्त रिपोर्ट', description: 'Career direction, favourable periods for change and money matters for the next 2 years.', price: 799, billing: 'one_time', icon: 'briefcase' },
    { id: 'r3', name: 'Marriage Compatibility', nameHi: 'विवाह मिलान', description: 'Guna milan and detailed compatibility analysis for two profiles.', price: 1199, billing: 'one_time', icon: 'heart' },
    { id: 'r4', name: 'Monthly Forecast', nameHi: 'मासिक भविष्यफल', description: 'A personalised forecast delivered at the start of every month.', price: 299, billing: 'monthly', icon: 'calendar' },
    { id: 'r5', name: 'Yearly Varshphal', nameHi: 'वार्षिक वर्षफल', description: 'Your year ahead, month by month, from your solar return chart.', price: 1499, billing: 'one_time', icon: 'sunny' },
  ] as const;
  for (const r of reports) await prisma.reportType.upsert({ where: { id: r.id }, update: {}, create: r });

  console.log(`Seeded ${practitioners.length} practitioners and ${reports.length} report types.`);
}

main().finally(() => prisma.$disconnect());
