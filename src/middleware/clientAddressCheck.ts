import { BlockList, isIP } from 'net';
import type { NextFunction, Request, Response } from 'express';
import { trustProxyHops } from '../utils/config';
import { logEvent } from '../utils/log';

/**
 * Says in the log whether the API sees the visitor's own network address or a proxy's, for the
 * first forwarded requests after each start. The request limits per address are only right when
 * it is the visitor's. No address is ever logged: only whether each candidate is public, private
 * or missing, and which of them agree. `TRUST_PROXY_HOPS` is then set from this line.
 */

const CHECKS_PER_START = 5;
let checksLeft = CHECKS_PER_START;

const notPublic = new BlockList();
for (const [network, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const)
  notPublic.addSubnet(network, bits, 'ipv4');
for (const [network, bits] of [
  ['::', 127],
  ['fc00::', 7],
  ['fe80::', 10],
] as const)
  notPublic.addSubnet(network, bits, 'ipv6');

const plain = (address: string | undefined) => address?.trim().replace(/^::ffff:(?=\d)/, '');

/** `public`, `private` or `missing`, never the address itself. */
export function addressKind(address: string | undefined): 'public' | 'private' | 'missing' {
  const value = plain(address);
  const family = value ? isIP(value) : 0;
  if (!value || !family) return 'missing';
  return notPublic.check(value, family === 4 ? 'ipv4' : 'ipv6') ? 'private' : 'public';
}

const header = (req: Request, name: string) => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

export function clientAddressCheck(req: Request, _res: Response, next: NextFunction) {
  const forwarded = header(req, 'x-forwarded-for');
  if (checksLeft > 0 && forwarded !== undefined) {
    checksLeft -= 1;
    const entries = forwarded.split(',').map((entry) => plain(entry));
    const seen = plain(req.ip);
    const cloudflare = plain(header(req, 'cf-connecting-ip'));
    logEvent('client_address_check', {
      trustedHops: trustProxyHops() ?? 0,
      forwardedEntries: entries.length,
      seen: addressKind(seen),
      firstForwarded: addressKind(entries[0]),
      cloudflare: addressKind(cloudflare),
      seenIsFirstForwarded: seen === entries[0],
      seenIsCloudflare: cloudflare !== undefined && seen === cloudflare,
      firstForwardedIsCloudflare: cloudflare !== undefined && entries[0] === cloudflare,
    });
  }
  next();
}

/** For tests: check the next requests again. */
export function resetClientAddressCheck() {
  checksLeft = CHECKS_PER_START;
}
