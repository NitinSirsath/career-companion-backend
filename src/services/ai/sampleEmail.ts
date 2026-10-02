/**
 * Built-in synthetic recruiter email for the user's sample test and evaluation case 1. Fictitious
 * company, people and reserved domains only; never user mail.
 */
export const SAMPLE_EMAIL = {
  sender: 'Priya Raman <priya.raman@northwind-robotics.example.com>',
  subject: 'Interview invitation: Senior Platform Engineer at Northwind Robotics',
  labels: ['INBOX', 'CATEGORY_UPDATES'],
  snippet:
    'Hi Alex, thank you for applying to the Senior Platform Engineer role at Northwind Robotics. We would like to invite you to a 45-minute video interview',
  body: [
    'Hi Alex,',
    '',
    'Thank you for applying to the Senior Platform Engineer role at Northwind Robotics.',
    'We would like to invite you to a 45-minute video interview with our engineering manager,',
    'Daniel Okafor, on Wednesday, November 4, 2026 at 2:00 PM Eastern Time.',
    '',
    'Please reply by Friday, October 30, 2026 to confirm the time, or suggest another slot that week.',
    'The video link will follow once you confirm.',
    '',
    'Best regards,',
    'Priya Raman',
    'Technical Recruiter, Northwind Robotics',
    'priya.raman@northwind-robotics.example.com',
  ].join('\n'),
} as const;
