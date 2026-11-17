/**
 * When two job titles name the same job (owner, 17 Nov 2026). Job sites add text to a title that
 * the user's own application does not have: "Front-end Developer (only for folks graduated in 2026
 * or earlier)" is the same job as "Front-end Developer". The company is checked by the caller.
 */
import { titleKey } from './externalSubmission';

/** Text in brackets, and everything after a dash or bar with a space before it, is dropped. */
const EXTRA_TEXT = /\([^)]*\)|\[[^\]]*\]|\{[^}]*\}|\s[-–—|].*$/g;

/** The title's words, lower case, letters and digits only. A hyphen inside a word joins it. */
function titleWords(title: string): string[] {
  return title
    .replace(EXTRA_TEXT, ' ')
    .toLowerCase()
    .replace(/(?<=[a-z0-9])-(?=[a-z0-9])/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** True when `part` appears in `whole` as whole words, in order and next to each other. */
function containsWords(whole: string[], part: string[]): boolean {
  if (!part.length || part.length > whole.length) return false;
  for (let start = 0; start + part.length <= whole.length; start++)
    if (part.every((word, i) => whole[start + i] === word)) return true;
  return false;
}

/**
 * The same job: equal once extra text is dropped ("Frontend" and "Front end" are equal), or one
 * title's words appear in the other ("Developer" never matches "Development Lead").
 */
export function sameJobTitle(a: string, b: string): boolean {
  if (titleKey(a) && titleKey(a) === titleKey(b)) return true;
  const left = titleWords(a);
  const right = titleWords(b);
  if (!left.length || !right.length) return false;
  if (left.join('') === right.join('')) return true;
  return containsWords(left, right) || containsWords(right, left);
}
