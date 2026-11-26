/**
 * When two company names mean the same company (owner, 26 Nov 2026). One rule for the mail matcher
 * and for what NorthList Apply reports: a confirmation mail says "Acme Limited" where the user's
 * application says "Acme", and with two rules the same job was saved twice.
 */
const LEGAL_SUFFIXES = new Set([
  'inc',
  'incorporated',
  'llc',
  'llp',
  'ltd',
  'limited',
  'pvt',
  'private',
  'corp',
  'corporation',
  'co',
  'plc',
  'gmbh',
]);

/**
 * The name in lower case, letters and digits only, after dropping trailing legal-suffix words
 * (always keeping the first word): "Acme Pvt. Ltd." and "ACME" both give `acme`.
 */
export function companyKey(name: string): string {
  const words = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join('');
}

/** Two names of the same company. A name with no letter or digit is no company's name. */
export const sameCompany = (a: string, b: string) =>
  !!companyKey(a) && companyKey(a) === companyKey(b);
