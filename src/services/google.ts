// Gmail API only. The full `googleapis` package ships types for every Google API,
// and `tsc` ran out of memory on Render while loading them.
import { auth, gmail, gmail_v1 } from '@googleapis/gmail';

export const google = { auth, gmail };
export { gmail_v1 };
