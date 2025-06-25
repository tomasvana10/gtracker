import { GoldRecord } from "../bot/tracker.ts";

export async function getRecords(kv: Deno.Kv) {
  const records = kv.list({ prefix: ["records"] });
  const result: Record<string, GoldRecord> = {};

  for await (const record of records) {
    const [, serverIdentifier, id] = record.key as [string, string, string];
    result[serverIdentifier] ??= {};
    result[serverIdentifier][id] = record.value as number;
  }

  return result;
}
