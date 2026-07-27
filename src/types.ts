declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string; email: string; isBootstrapAdmin: boolean; mustChangePassword: boolean };
    }
  }
}

export {};
