import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { config } from "https://deno.land/x/dotenv@v3.2.2/mod.ts";

const env = config();
const UPDATE_TOKEN = Deno.env.get("UPDATE_TOKEN") ?? env.UPDATE_TOKEN;
const WIPE_TOKEN = Deno.env.get("WIPE_TOKEN") ?? env.WIPE_TOKEN;
const kv = await Deno.openKv();

const app = new Hono();

app.use("/api/update", bearerAuth({ token: UPDATE_TOKEN }));
app.use("/api/wipe", bearerAuth({ token: WIPE_TOKEN }));

app.post("/api/update", async c => {
  const { serverIdentifier, data } = await c.req.json();

  if (
    typeof serverIdentifier !== "string" ||
    typeof data?.uuid !== "string" ||
    typeof data?.goldCount !== "number"
  )
    return c.text("Bad request", 400);

  await kv.set(["records", serverIdentifier, data.uuid], data.goldCount);
  return c.text("Updated");
});

app.post("/api/wipe", async c => {
  const { type, serverIdentifier, keys } = await c.req.json();

  if (typeof type !== "string") return c.text("Bad request", 400);

  if (type === "all") {
    const entries = kv.list({ prefix: ["records"] });
    for await (const entry of entries) await kv.delete(entry.key);
    return c.text("All records wiped");
  }

  if (type === "multiple") {
    if (typeof serverIdentifier !== "string" || !Array.isArray(keys))
      return c.text("Bad request", 400);

    const paths = keys.map(key => ["records", serverIdentifier, key]);
    for (const path of paths) await kv.delete(path);
    return c.text("Keys deleted");
  }
});

app.get("/api/records", async c => {
  const records = kv.list({ prefix: ["records"] });
  const result: Record<string, Record<string, number>> = {};

  for await (const record of records) {
    const [, serverIdentifier, id] = record.key as [string, string, string];
    result[serverIdentifier] ??= {};
    result[serverIdentifier][id] = record.value as number;
  }

  return c.json(result);
});

Deno.serve(app.fetch);
