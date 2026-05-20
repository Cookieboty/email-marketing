export function parseIpWhitelistText(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

export function ipWhitelistToText(items: string[] | undefined | null): string {
  if (!items || items.length === 0) return "";
  return items.join("\n");
}
