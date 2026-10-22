import { describe, expect, it } from 'vitest';
import { returnPath } from '../utils/returnPath';

describe('the return path after a Google flow', () => {
  it.each(['/', '/applications/123', '/mails?tab=gmail', '/mails/18c2f0a1#reply', '/a?b=%2F%2Fc'])(
    'keeps a path inside the app (%s)',
    (path) => {
      expect(returnPath(path, '/home')).toBe(path);
    },
  );

  it.each([
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    '/applications\\123',
    '/\t/evil.example',
    '/\n/evil.example',
    '/mails?q=two words',
    '/café',
    ' /applications',
    'applications/123',
    'evil.example',
    '',
  ])('turns anything else into the fallback (%j)', (value) => {
    expect(returnPath(value, '/home')).toBe('/home');
  });

  it.each([undefined, null, 42, ['/applications/123'], { path: '/applications/123' }])(
    'turns a value that is not text into the fallback (%j)',
    (value) => {
      expect(returnPath(value, '/home')).toBe('/home');
    },
  );

  it('lets a flow narrow the rule, but never widen it', () => {
    const mailPage = /^\/mails\/\d+$/;
    expect(returnPath('/mails/42', '/gmail', mailPage)).toBe('/mails/42');
    expect(returnPath('/applications/42', '/gmail', mailPage)).toBe('/gmail');
    expect(returnPath('//evil.example', '/gmail', /evil/)).toBe('/gmail');
  });
});
