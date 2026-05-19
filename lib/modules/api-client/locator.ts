/**
 * Inbound 路由通用辅助：根据 email/userId/externalId 定位用户。
 *
 * 关联 spec：specs/modules/inbound-connector.md
 */

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { normalizeEmail } from "@/lib/email-utils";

export const UserLocatorShape = {
  userId: z.string().min(1).optional(),
  email: z.string().email().optional(),
  externalId: z.string().min(1).optional(),
};

export const UserLocatorSchema = z
  .object(UserLocatorShape)
  .refine((v) => v.userId || v.email || v.externalId, {
    message: "userId, email or externalId is required",
  });

export type UserLocator = z.infer<typeof UserLocatorSchema>;

export interface LocatedUser {
  id: string;
  email: string;
  externalId: string | null;
}

export async function locateUser(input: UserLocator): Promise<LocatedUser> {
  if (input.userId) {
    const u = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true, email: true, externalId: true },
    });
    if (!u) throw new NotFoundError("User not found");
    return u;
  }
  if (input.externalId) {
    const u = await prisma.user.findUnique({
      where: { externalId: input.externalId },
      select: { id: true, email: true, externalId: true },
    });
    if (!u) throw new NotFoundError("User not found");
    return u;
  }
  if (input.email) {
    const email = normalizeEmail(input.email);
    const u = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, externalId: true },
    });
    if (!u) throw new NotFoundError("User not found");
    return u;
  }
  throw new ValidationError("Locator required");
}
