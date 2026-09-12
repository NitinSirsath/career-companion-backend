import 'express';
import 'express-session';

declare module 'express-serve-static-core' {
  export interface Request {
    auth?: {
      user: {
        id: string;
        email: string;
        name: string | null;
      };
    };
  }
}

declare module 'express-session' {
  interface SessionData {
    userId: string;
  }
}
