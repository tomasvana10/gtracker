import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import BOT from "./bot/index.ts";
import envars from "./util/envars.ts";
import { getRecords } from "./util/storage.ts";
import kv from "./util/kv.ts";
import DiscordChannelTracker from "./bot/tracker.ts";

const app = new Hono();

app.use("/api/update", bearerAuth({ token: envars.UPDATE_TOKEN }));
app.use("/api/wipe", bearerAuth({ token: envars.WIPE_TOKEN }));

app.post("/api/update", async c => {
  const { serverIdentifier, data } = await c.req.json();

  if (
    typeof serverIdentifier !== "string" ||
    typeof data?.uuid !== "string" ||
    typeof data?.goldCount !== "number"
  )
    return c.text("Bad request", 400);

  await kv.set(["records", serverIdentifier, data.uuid], data.goldCount);
  await DiscordChannelTracker.update(
    serverIdentifier,
    await getRecords(kv).then(res => res[serverIdentifier])
  );
  return c.text("Updated");
});

app.post("/api/wipe", async c => {
  const { type, serverIdentifier, keys } = await c.req.json();

  if (typeof type !== "string") return c.text("Bad request", 400);

  const updateDiscord = async () =>
    await DiscordChannelTracker.update(
      serverIdentifier,
      await getRecords(kv).then(res => res[serverIdentifier])
    );

  if (type === "all") {
    const entries = kv.list({ prefix: ["records"] });
    for await (const entry of entries) await kv.delete(entry.key);
    await updateDiscord();
    return c.text("All records wiped");
  } else if (type === "multiple") {
    if (typeof serverIdentifier !== "string" || !Array.isArray(keys))
      return c.text("Bad request", 400);

    const paths = keys.map(key => ["records", serverIdentifier, key]);
    for (const path of paths) await kv.delete(path);
    await updateDiscord();
    return c.text("Keys deleted");
  }
});

app.get("/api/records", async c => {
  return c.json(await getRecords(kv));
});

Deno.serve(app.fetch);

await BOT.start();
