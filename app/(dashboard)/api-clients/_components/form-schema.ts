import { z } from "zod";
import { SCOPES } from "@/lib/modules/api-client/schema";

function isValidIpEntry(input: string): boolean {
  const [address, cidr, extra] = input.trim().split("/");
  if (!address || extra !== undefined) return false;

  if (address.includes(".")) {
    const parts = address.split(".");
    const validAddress =
      parts.length === 4 &&
      parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
    const validCidr =
      cidr === undefined || (/^\d+$/.test(cidr) && Number(cidr) >= 0 && Number(cidr) <= 32);
    return validAddress && validCidr;
  }

  if (address.includes(":")) {
    const validAddress =
      /^[0-9a-fA-F:]+$/.test(address) &&
      address.split("::").length <= 2 &&
      address.split(":").filter(Boolean).length <= 8;
    const validCidr =
      cidr === undefined || (/^\d+$/.test(cidr) && Number(cidr) >= 0 && Number(cidr) <= 128);
    return validAddress && validCidr;
  }

  return false;
}

const IpEntrySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidIpEntry, "需要 IPv4/IPv6（可带 CIDR）");

export const CreateApiClientFormSchema = z.object({
  name: z.string().trim().min(1, "请输入名称").max(120),
  description: z.string().trim().max(500).optional().or(z.literal("")),
  scopes: z.array(z.enum(SCOPES)).min(1, "至少选择一个权限"),
  ipWhitelist: z.array(IpEntrySchema).max(50).optional(),
  rpsLimit: z.number().int().positive().max(10_000).optional(),
  rphLimit: z.number().int().positive().max(1_000_000).optional(),
  enableHmac: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type CreateApiClientFormValues = z.infer<typeof CreateApiClientFormSchema>;

export const UpdateApiClientFormSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    scopes: z.array(z.enum(SCOPES)).min(1).optional(),
    ipWhitelist: z.array(IpEntrySchema).max(50).optional(),
    rpsLimit: z.number().int().positive().max(10_000).nullable().optional(),
    rphLimit: z.number().int().positive().max(1_000_000).nullable().optional(),
    status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  })
  .strict();

export type UpdateApiClientFormValues = z.infer<typeof UpdateApiClientFormSchema>;

export function buildApiClientFormPayload(
  mode: "create" | "edit",
  values: CreateApiClientFormValues,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: values.name,
    scopes: values.scopes,
    ipWhitelist: values.ipWhitelist ?? [],
  };

  if (mode === "create") {
    if (values.description !== undefined && values.description !== "") {
      payload.description = values.description;
    }
    if (values.rpsLimit !== undefined) payload.rpsLimit = values.rpsLimit;
    if (values.rphLimit !== undefined) payload.rphLimit = values.rphLimit;
    payload.enableHmac = Boolean(values.enableHmac);
    return payload;
  }

  payload.description = values.description && values.description.length > 0 ? values.description : null;
  payload.rpsLimit = values.rpsLimit ?? null;
  payload.rphLimit = values.rphLimit ?? null;
  return payload;
}
