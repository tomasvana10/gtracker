import { serve } from "https://deno.land/std@0.224.0/http/mod.ts";

const kv = await Deno.openKv();

serve(async req => {
  const { pathname } = new URL(req.url);

  if (req.method === "POST" && pathname === "/api/update") {
    const { name, val } = await req.json();
    if (typeof name !== "string" || typeof val !== "number") {
      return new Response("Bad Request", { status: 400 });
    }

    await kv.set(["records", name], val);
    return new Response("Updated", { status: 200 });
  }

  if (req.method === "GET" && pathname === "/api/records") {
    const entries = kv.list({ prefix: ["records"] });
    const result: Record<string, number> = {};

    for await (const entry of entries) {
      const key = entry.key[1] as string;
      result[key] = entry.value as number;
    }

    return Response.json(result);
  }

  return new Response("Not Found", { status: 404 });
});
