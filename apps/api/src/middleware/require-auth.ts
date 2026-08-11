import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "../lib/auth.js";
import { prisma } from "../lib/prisma.js";

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.header("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  const token = authHeader.slice("Bearer ".length).trim();

  try {
    const payload = verifyToken(token);
    if (!payload.userId || !Number.isInteger(payload.authVersion)) {
      res.status(401).json({ message: "Invalid token" });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, phone: true, authVersion: true }
    });

    if (!user || user.authVersion !== payload.authVersion) {
      res.status(401).json({ message: "Session expired" });
      return;
    }

    req.user = {
      userId: user.id,
      phone: user.phone,
      authVersion: user.authVersion,
      impersonatedByUserId: payload.impersonatedByUserId
    };
    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
}
