import { z } from 'zod';

// ─── Get an invite for the release (owner, 22 Nov 2026) ──────────────────────
// While the beta is full, the sign-in page asks for an email and where the person heard about
// NorthList. The owner sees the list on the Admin page and writes to it at the release.

export const InviteSourceSchema = z.enum(['FRIEND', 'LINKEDIN', 'X', 'YOUTUBE', 'SEARCH', 'OTHER']);
export type InviteSource = z.infer<typeof InviteSourceSchema>;

export const INVITE_OTHER_SOURCE_MAX_LENGTH = 100;

// POST /api/invites (signed out): always 200 with the same answer, also when the email already
// asked, so the answer never tells whether an email is on the list.
export const InviteRequestSchema = z
  .strictObject({
    email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
    source: InviteSourceSchema,
    /** The person's own words; only with OTHER, and needed then. */
    otherSource: z.string().trim().min(1).max(INVITE_OTHER_SOURCE_MAX_LENGTH).optional(),
  })
  .refine((input) => (input.source === 'OTHER') === (input.otherSource !== undefined), {
    message: 'Say where, only when you pick Other.',
    path: ['otherSource'],
  });
export type InviteRequest = z.infer<typeof InviteRequestSchema>;

export const InviteResponseSchema = z.object({ saved: z.literal(true) });
export type InviteResponse = z.infer<typeof InviteResponseSchema>;

/** One request on the Admin page. */
export const AdminInviteSchema = z.object({
  email: z.string(),
  source: InviteSourceSchema,
  otherSource: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type AdminInvite = z.infer<typeof AdminInviteSchema>;

// GET /api/admin/invites: every request, newest first.
export const AdminInvitesResponseSchema = z.object({ invites: z.array(AdminInviteSchema) });
export type AdminInvitesResponse = z.infer<typeof AdminInvitesResponseSchema>;
