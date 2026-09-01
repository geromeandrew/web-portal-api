declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        oktaSubject: string;
        email: string;
        createdAt: Date;
        tokenExpiresAt: Date;
      };
    }
  }
}

export {};
