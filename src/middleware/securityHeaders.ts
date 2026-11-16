import helmet from 'helmet';

/**
 * Standard safety headers on every answer, health checks and MCP included. Helmet removes
 * `X-Powered-By` and adds nosniff, HSTS and the other defaults. The API answers only JSON and
 * redirects, so its own policy allows nothing to load and no page to show it in a frame.
 */
export const securityHeaders = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
  },
  xFrameOptions: { action: 'deny' },
});
