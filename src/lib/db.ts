// Prisma singleton.
//
// Next.js dev mode hot-reloads modules, which would otherwise spawn a new
// PrismaClient on every change and exhaust the SQLite connection. We cache
// the instance on `globalThis` in development to avoid this.

import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
