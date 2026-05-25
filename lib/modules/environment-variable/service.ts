import type { EnvironmentVariable } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { BUILTIN_VARIABLE_NAMES } from "@/lib/template-engine";

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const BUILTIN_SET = new Set<string>(BUILTIN_VARIABLE_NAMES);

interface ActorContext {
  actorType: "ADMIN" | "SYSTEM" | "WEBHOOK";
  req?: { headers: Headers } | null;
}

export interface CreateEnvVarInput {
  key: string;
  value: string;
  description?: string;
}

export interface UpdateEnvVarInput {
  value?: string;
  description?: string;
}

function validateKey(key: string): void {
  if (!KEY_RE.test(key)) {
    throw new ValidationError(
      "Variable key must start with a letter and contain only letters, digits, and underscores",
    );
  }
  if (BUILTIN_SET.has(key)) {
    throw new ValidationError(`Key "${key}" conflicts with a builtin variable`);
  }
}

export const environmentVariableService = {
  async list(): Promise<EnvironmentVariable[]> {
    return prisma.environmentVariable.findMany({ orderBy: { key: "asc" } });
  },

  async create(input: CreateEnvVarInput, ctx: ActorContext): Promise<EnvironmentVariable> {
    validateKey(input.key);
    const existing = await prisma.environmentVariable.findUnique({ where: { key: input.key } });
    if (existing) throw new ConflictError(`Key "${input.key}" already exists`);

    const record = await prisma.environmentVariable.create({
      data: {
        key: input.key,
        value: input.value,
        description: input.description ?? null,
      },
    });
    audit({
      action: "environment_variable.create",
      entityType: "EnvironmentVariable",
      entityId: record.id,
      actorType: ctx.actorType,
      details: { key: record.key },
      req: ctx.req ?? null,
    });
    return record;
  },

  async update(id: string, input: UpdateEnvVarInput, ctx: ActorContext): Promise<EnvironmentVariable> {
    const existing = await prisma.environmentVariable.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Environment variable not found");

    const record = await prisma.environmentVariable.update({
      where: { id },
      data: {
        ...(input.value !== undefined ? { value: input.value } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
    });
    audit({
      action: "environment_variable.update",
      entityType: "EnvironmentVariable",
      entityId: id,
      actorType: ctx.actorType,
      details: { key: existing.key, fields: Object.keys(input) },
      req: ctx.req ?? null,
    });
    return record;
  },

  async remove(id: string, ctx: ActorContext): Promise<void> {
    const existing = await prisma.environmentVariable.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Environment variable not found");

    await prisma.environmentVariable.delete({ where: { id } });
    audit({
      action: "environment_variable.delete",
      entityType: "EnvironmentVariable",
      entityId: id,
      actorType: ctx.actorType,
      details: { key: existing.key },
      req: ctx.req ?? null,
    });
  },

  async getVariablesMap(): Promise<Record<string, string>> {
    const rows = await prisma.environmentVariable.findMany({
      select: { key: true, value: true },
    });
    const map: Record<string, string> = {};
    for (const r of rows) {
      map[r.key] = r.value;
    }
    return map;
  },
};
