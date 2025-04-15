import { serve } from "https://deno.land/std@0.224.0/http/mod.ts";
import { config } from "https://deno.land/x/dotenv@v3.2.2/mod.ts";

const env = config();
const UPDATE_TOKEN = env.UPDATE_TOKEN;
const WIPE_TOKEN = env.WIPE_TOKEN;

const kv = await Deno.openKv();

function validateToken(req: Request, token: string): boolean {
  const authorization = req.headers.get("Authorization");
  if (!authorization) return false;

  const [scheme, providedToken] = authorization.split(" ");
  return scheme === "Bearer" && providedToken === token;
}

serve(async req => {
  const { pathname } = new URL(req.url);

  if (pathname === "/api/update") {
    if (req.method !== "POST")
      return new Response("Invalid Method", { status: 405 });
    if (!validateToken(req, UPDATE_TOKEN)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const { name, val } = await req.json();
    if (typeof name !== "string" || typeof val !== "number") {
      return new Response("Bad Request", { status: 400 });
    }

    await kv.set(["records", name], val);
    return new Response("Updated", { status: 200 });
  }

  if (pathname === "/api/wipe") {
    if (req.method !== "POST")
      return new Response("Invalid Method", { status: 405 });
    if (!validateToken(req, WIPE_TOKEN)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const { type, key } = await req.json();

    if (type === "all") {
      const entries = kv.list({ prefix: ["records"] });
      for await (const entry of entries) {
        await kv.delete(entry.key);
      }
      return new Response("All records wiped", { status: 200 });
    }

    if (type === "single" && typeof key === "string") {
      await kv.delete(["records", key]);
      return new Response(`Record ${key} deleted`, { status: 200 });
    }

    return new Response("Bad Request", { status: 400 });
  }

  if (pathname === "/api/records") {
    if (req.method !== "GET") {
      return new Response("Invalid Method", { status: 405 });
    }

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
