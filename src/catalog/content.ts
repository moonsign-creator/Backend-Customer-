// Static content mirrored from the app. In production these would come from the admin CMS.

export const COMMON_QUESTIONS: Record<string, string[]> = {
  Relationship: ['Will my current relationship lead to marriage?', 'When will I meet the right partner?', 'How can I improve understanding with my partner?'],
  'Marriage / Relationship': ['When is a favourable time for my marriage?', 'Is my partner compatible with me?', 'How can we reduce conflicts at home?'],
  Career: ['Is this a good time to change my job?', 'Which career field suits me best?', 'When will I get a promotion?'],
  Health: ['Which health areas should I take care of this year?', 'When will my health improve?', 'Is there a remedy for my recurring health problem?'],
  Finance: ['Is this a good period to invest?', 'When will my financial situation improve?', 'Should I start my own business?'],
  Children: ['When will we be blessed with a child?', "How will my child's education go?", 'What career suits my child?'],
  Others: ['Is this a good time to buy property?', 'Will I travel abroad?', 'What remedies will bring peace at home?'],
};

export const PLACES = [
  'New Delhi, Delhi', 'Mumbai, Maharashtra', 'Kolkata, West Bengal', 'Chennai, Tamil Nadu',
  'Bengaluru, Karnataka', 'Hyderabad, Telangana', 'Pune, Maharashtra', 'Ahmedabad, Gujarat',
  'Jaipur, Rajasthan', 'Lucknow, Uttar Pradesh', 'Varanasi, Uttar Pradesh', 'Patna, Bihar',
  'Bhopal, Madhya Pradesh', 'Chandigarh', 'Guwahati, Assam', 'Bhubaneswar, Odisha',
];

export const SIGNS = ['Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo', 'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'];
export const SIGNS_HI = ['मेष', 'वृषभ', 'मिथुन', 'कर्क', 'सिंह', 'कन्या', 'तुला', 'वृश्चिक', 'धनु', 'मकर', 'कुंभ', 'मीन'];

export const DAILY_LINES = [
  'The Moon supports clear conversations today. A pending matter at work moves forward if you take the first step.',
  'Expect a calm, productive day. Family support lifts your mood; avoid lending money this afternoon.',
  'Your energy is high. Use it for tasks you have been postponing, but keep your words gentle at home.',
  'A good day for planning finances. An old friend may bring useful news by evening.',
  'Health needs a little attention. Rest well and choose light food. Creative work is favoured.',
  'Relationships feel warm and supportive. A small journey or outing will refresh you.',
];

export const WEEKLY_HOROSCOPE = {
  source: 'Written by the NamyaAstro team',
  text: 'This week Jupiter strengthens your house of learning. Mid-week is good for career conversations and signing documents. Keep expenses in check over the weekend, and spend time with elders for their blessings.',
};

export const PERSONAL_DAY_MEANING: Record<number, { title: string; text: string }> = {
  1: { title: 'New beginnings', text: 'Start something new. Take the lead and trust your own judgement today.' },
  2: { title: 'Cooperation', text: 'A day for patience, partnerships and listening. Avoid forcing decisions.' },
  3: { title: 'Expression', text: 'Creativity and communication flow easily. Reach out, write, share ideas.' },
  4: { title: 'Hard work', text: 'Focus on routine, planning and finishing tasks. Steady effort pays off.' },
  5: { title: 'Change', text: 'Expect the unexpected. Stay flexible and open to short trips or new people.' },
  6: { title: 'Family & care', text: 'Home, family and responsibilities need attention. Offer help where you can.' },
  7: { title: 'Reflection', text: 'Slow down, study, meditate. Good for inner work rather than big moves.' },
  8: { title: 'Achievement', text: 'Money and career matters are favoured. Make the practical decision.' },
  9: { title: 'Completion', text: 'Let go of what no longer serves you. Wrap up and forgive.' },
};
