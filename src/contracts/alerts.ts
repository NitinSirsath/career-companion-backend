/**
 * Push alerts on a device (owner, 30 Oct 2026): an alert when NorthList makes a new step that
 * needs the user. Each phone or computer turns alerts on by itself. Shared with the frontend by
 * sync-contracts.
 */
import { z } from 'zod';

/** A device's push address, as the browser's `PushSubscription.toJSON()` gives it. */
const Endpoint = z.url({ protocol: /^https$/ }).max(2048);

// ─── GET /api/alerts/key ────────────────────────────────────────────────────

/** `available` is false when the server has no alert keys; the Account page then hides alerts. */
export const AlertKeyResponseSchema = z.object({
  available: z.boolean(),
  publicKey: z.string().nullable(),
});
export type AlertKeyResponse = z.infer<typeof AlertKeyResponseSchema>;

// ─── POST /api/alerts/devices ───────────────────────────────────────────────

/** Turns alerts on for this device. The same endpoint again updates its keys. */
export const TurnOnAlertsRequestSchema = z.object({
  endpoint: Endpoint,
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(64),
  }),
});
export type TurnOnAlertsRequest = z.infer<typeof TurnOnAlertsRequestSchema>;

/** Turning on sends one alert at once; `firstAlertSent` says whether the push service took it. */
export const TurnOnAlertsResponseSchema = z.object({
  on: z.literal(true),
  firstAlertSent: z.boolean(),
});
export type TurnOnAlertsResponse = z.infer<typeof TurnOnAlertsResponseSchema>;

// ─── POST /api/alerts/devices/off ───────────────────────────────────────────

/** Turns alerts off for this device. Nothing to remove is still a success. */
export const TurnOffAlertsRequestSchema = z.object({ endpoint: Endpoint });
export type TurnOffAlertsRequest = z.infer<typeof TurnOffAlertsRequestSchema>;

export const TurnOffAlertsResponseSchema = z.object({ on: z.literal(false) });
export type TurnOffAlertsResponse = z.infer<typeof TurnOffAlertsResponseSchema>;
