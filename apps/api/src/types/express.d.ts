declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        phone: string;
        authVersion: number;
        impersonatedByUserId?: string;
      };
    }
  }
}

export {};
