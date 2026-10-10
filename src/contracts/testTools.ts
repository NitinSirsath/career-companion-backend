import { z } from 'zod';

// ─── Test tools (manual test environment only; never on live) ────────────────
// Shared with the frontend. Keep this file free of ES2021+ APIs (no replaceAll, no .at()).

/** Test-inbox Gmail message and thread IDs start with this. Real Gmail IDs are hex, so they never collide. */
export const SIMULATED_ID_PREFIX = 'sim-';
export const isSimulatedId = (id: string | null | undefined): boolean =>
  typeof id === 'string' && id.startsWith(SIMULATED_ID_PREFIX);

/** The Gmail category a test email arrives with. INBOX is always added. */
export const TEST_EMAIL_LABELS = [
  'CATEGORY_PRIMARY',
  'CATEGORY_UPDATES',
  'CATEGORY_PROMOTIONS',
  'CATEGORY_SOCIAL',
  'SPAM',
] as const;
export type TestEmailLabel = (typeof TEST_EMAIL_LABELS)[number];

export const SimulatedThreadIdSchema = z.string().regex(/^sim-thread-[a-z0-9-]{8,64}$/);

// GET /api/test-tools/status (404 when test tools are off)
export const TestToolsStatusSchema = z.object({ enabled: z.literal(true) });
export type TestToolsStatus = z.infer<typeof TestToolsStatusSchema>;

// POST /api/test-tools/emails
export const DeliverTestEmailRequestSchema = z.strictObject({
  sender: z.string().trim().min(3).max(512),
  subject: z.string().trim().max(1000),
  body: z.string().trim().min(1).max(8000),
  label: z.enum(TEST_EMAIL_LABELS),
  /** Reply in an existing test thread; omit to start a new thread. */
  threadId: SimulatedThreadIdSchema.optional(),
});
export type DeliverTestEmailRequest = z.infer<typeof DeliverTestEmailRequestSchema>;
export const DeliverTestEmailResponseSchema = z.object({
  emailId: z.string(),
  threadId: z.string(),
});
export type DeliverTestEmailResponse = z.infer<typeof DeliverTestEmailResponseSchema>;

// POST /api/test-tools/reset
export const ResetTestDataRequestSchema = z.strictObject({ confirm: z.literal('RESET') });
export type ResetTestDataRequest = z.infer<typeof ResetTestDataRequestSchema>;
export const ResetTestDataResponseSchema = z.object({
  deletedEmails: z.number().int(),
  deletedApplications: z.number().int(),
});
export type ResetTestDataResponse = z.infer<typeof ResetTestDataResponseSchema>;

// ─── Ready-made test emails ──────────────────────────────────────────────────
// Synthetic only: fictitious people, reserved example.com domains (LinkedIn senders excepted, so
// the LinkedIn rules can be tested). The emails are fake; the AI that reads them is the user's
// real provider.

export type TestEmailGroup = 'Job emails' | 'Not job emails' | 'LinkedIn';

export interface TestEmailTemplate {
  id: string;
  name: string;
  group: TestEmailGroup;
  sender: string;
  subject: string;
  body: string;
  label: TestEmailLabel;
}

export interface TemplateValues {
  company: string;
  role: string;
}

const lines = (...text: string[]) => text.join('\n');

export const TEST_EMAIL_TEMPLATES: readonly TestEmailTemplate[] = [
  {
    id: 'application-received',
    name: 'Application received',
    group: 'Job emails',
    sender: 'Careers at {company} <careers@{domain}>',
    subject: 'We received your application: {role}',
    body: lines(
      'Hi Alex,',
      '',
      'Thank you for applying for the {role} role at {company}.',
      'Our hiring team is reviewing your application and will contact you about next steps.',
      '',
      'Best regards,',
      'Talent Team, {company}',
    ),
    label: 'CATEGORY_UPDATES',
  },
  {
    id: 'recruiter-outreach',
    name: 'Recruiter outreach',
    group: 'Job emails',
    sender: 'Priya Raman <priya.raman@{domain}>',
    subject: 'Opportunity at {company}',
    body: lines(
      'Hi Alex,',
      '',
      'I am a recruiter at {company}. Your background looks like a strong fit for the {role} role at {company}.',
      'Would you have 20 minutes this week for a short call? Please reply with a time that works for you.',
      '',
      'Thanks,',
      'Priya Raman',
      'Recruiter, {company}',
      'priya.raman@{domain}',
    ),
    label: 'CATEGORY_PRIMARY',
  },
  {
    id: 'assessment',
    name: 'Coding assessment',
    group: 'Job emails',
    sender: 'Hiring Team <hiring@{domain}>',
    subject: 'Next step: coding assessment for {role}',
    body: lines(
      'Hi Alex,',
      '',
      'Thanks for your interest in the {role} role at {company}.',
      'The next step is a 90-minute online coding assessment.',
      'Please complete the assessment by 2026-10-30.',
      '',
      'Good luck,',
      'Hiring Team, {company}',
    ),
    label: 'CATEGORY_UPDATES',
  },
  {
    id: 'interview-invite',
    name: 'Interview invitation',
    group: 'Job emails',
    sender: 'Priya Raman <priya.raman@{domain}>',
    subject: 'Interview invitation: {role} at {company}',
    body: lines(
      'Hi Alex,',
      '',
      'Thank you for applying for the {role} role at {company}.',
      'We would like to invite you to a 45-minute video interview on 2026-11-04 at 14:00 India time.',
      'Please reply by 2026-10-30 to confirm the time.',
      '',
      'Best regards,',
      'Priya Raman',
      'Recruiter, {company}',
      'priya.raman@{domain}',
    ),
    label: 'CATEGORY_PRIMARY',
  },
  {
    id: 'interview-moved',
    name: 'Interview moved',
    group: 'Job emails',
    sender: 'Priya Raman <priya.raman@{domain}>',
    subject: 'Interview moved: {role} at {company}',
    body: lines(
      'Hi Alex,',
      '',
      'We need to move your interview for the {role} role at {company}.',
      'The new time is 2026-11-06 at 11:00 India time, still by video.',
      'Please reply to confirm the new time.',
      '',
      'Thanks,',
      'Priya Raman',
    ),
    label: 'CATEGORY_PRIMARY',
  },
  {
    id: 'offer',
    name: 'Job offer',
    group: 'Job emails',
    sender: 'Priya Raman <priya.raman@{domain}>',
    subject: 'Your job offer from {company}',
    body: lines(
      'Hi Alex,',
      '',
      'We are pleased to offer you the {role} role at {company}.',
      'Your offer letter is attached to this email.',
      'Please sign and return it by 2026-11-20.',
      '',
      'Congratulations,',
      'Priya Raman',
    ),
    label: 'CATEGORY_PRIMARY',
  },
  {
    id: 'rejection',
    name: 'Rejection',
    group: 'Job emails',
    sender: 'Talent Team <talent@{domain}>',
    subject: 'Update on your application to {company}',
    body: lines(
      'Hi Alex,',
      '',
      'Thank you for your interest in the {role} role at {company}.',
      'Unfortunately, we will not be moving forward with your application.',
      'We wish you the best in your search.',
      '',
      'Regards,',
      'Talent Team, {company}',
    ),
    label: 'CATEGORY_UPDATES',
  },
  {
    id: 'follow-up',
    name: 'Recruiter follow-up',
    group: 'Job emails',
    sender: 'Priya Raman <priya.raman@{domain}>',
    subject: 'Following up: {role} at {company}',
    body: lines(
      'Hi Alex,',
      '',
      'I am following up on your application for the {role} role at {company}.',
      'The team is still reviewing candidates and we expect to share an update next week.',
      '',
      'Thanks,',
      'Priya Raman',
    ),
    label: 'CATEGORY_PRIMARY',
  },
  {
    id: 'newsletter',
    name: 'Newsletter (Promotions)',
    group: 'Not job emails',
    sender: 'Weekly Digest <news@digest.example.com>',
    subject: 'Your weekly product digest',
    body: 'This week: five new features, two webinars and a customer story. Read more on our blog.',
    label: 'CATEGORY_PROMOTIONS',
  },
  {
    id: 'one-time-code',
    name: 'Bank one-time password',
    group: 'Not job emails',
    sender: 'Example Bank <alerts@bank.example.com>',
    subject: 'Your one-time password',
    body: 'Your one-time password is 482913. It expires in 10 minutes. Do not share this code with anyone.',
    label: 'CATEGORY_UPDATES',
  },
  {
    id: 'linkedin-inmail',
    name: 'LinkedIn message from a recruiter',
    group: 'LinkedIn',
    sender: 'Arjun Mehta via LinkedIn <inmail-hit-reply@linkedin.com>',
    subject: '{role} opening at {company}',
    body: lines(
      'Hi Alex,',
      '',
      'I came across your profile and think you would be a great fit for the {role} role at {company}.',
      'Are you open to a quick chat this week? Please reply here on LinkedIn.',
      '',
      'Arjun Mehta',
      'Talent Partner, {company}',
    ),
    label: 'CATEGORY_SOCIAL',
  },
  {
    id: 'linkedin-job-alert',
    name: 'LinkedIn job alert',
    group: 'LinkedIn',
    sender: 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>',
    subject: '30 new jobs for you in Pune',
    body: 'New jobs that match your saved search: Platform Engineer, Site Reliability Engineer, DevOps Engineer and more. See all jobs on LinkedIn.',
    label: 'CATEGORY_SOCIAL',
  },
];

export interface TestScenario {
  id: string;
  name: string;
  description: string;
  /** Create the application (company + role) before the first email. */
  createApplication: boolean;
  /** All steps reply in one test thread, like a real conversation. */
  sameThread: boolean;
  /** Template IDs, delivered one at a time in this order. */
  steps: readonly string[];
}

export const TEST_SCENARIOS: readonly TestScenario[] = [
  {
    id: 'offer-path',
    name: 'Applied → Assessment → Interview → Offer',
    description: 'Creates the application, then delivers four emails in one thread.',
    createApplication: true,
    sameThread: true,
    steps: ['application-received', 'assessment', 'interview-invite', 'offer'],
  },
  {
    id: 'rejection-path',
    name: 'Applied → Interview → Rejection',
    description: 'Creates the application, then delivers three emails in one thread.',
    createApplication: true,
    sameThread: true,
    steps: ['application-received', 'interview-invite', 'rejection'],
  },
  {
    id: 'no-application',
    name: 'Recruiter emails with no application',
    description:
      'No application is created, so the emails should stay unmatched until you link them.',
    createApplication: false,
    sameThread: true,
    steps: ['recruiter-outreach', 'interview-invite'],
  },
  {
    id: 'not-job',
    name: 'Not job emails',
    description: 'Delivers emails that must end up as not job-related.',
    createApplication: false,
    sameThread: false,
    steps: ['newsletter', 'one-time-code', 'linkedin-job-alert'],
  },
];

/** company.example.com style domain for a company name. */
export function companyDomain(company: string): string {
  const slug = company
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'company'}.example.com`;
}

const fill = (text: string, values: TemplateValues) =>
  text
    .split('{company}')
    .join(values.company)
    .split('{role}')
    .join(values.role)
    .split('{domain}')
    .join(companyDomain(values.company));

/** A template with {company}, {role} and {domain} filled in, ready to deliver. */
export function fillTemplate(
  template: TestEmailTemplate,
  values: TemplateValues,
): Pick<DeliverTestEmailRequest, 'sender' | 'subject' | 'body' | 'label'> {
  return {
    sender: fill(template.sender, values),
    subject: fill(template.subject, values),
    body: fill(template.body, values),
    label: template.label,
  };
}
