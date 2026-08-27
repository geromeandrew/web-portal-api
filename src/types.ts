declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        email: string;
        isBootstrapAdmin: boolean;
        mustChangePassword: boolean;
        sessionId: string;
        tokenId: string;
        tokenExpiresAt: Date;
      };
    }
  }
}

export {};
