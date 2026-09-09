declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        oktaSubject: string;
        email: string;
        displayName: string | null;
        createdAt: Date;
        tokenExpiresAt: Date;
      };
    }
  }
}

export {};
