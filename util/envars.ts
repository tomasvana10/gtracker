import { config } from "https://deno.land/x/dotenv@v3.2.2/mod.ts";

const env = config();

const getVarValue = (name: string) => Deno.env.get(name) ?? env[name];

const vars = [
  "UPDATE_TOKEN",
  "WIPE_TOKEN",
  "DISCORD_BOT_TOKEN",
  "DISCORD_BOT_CLIENT_ID",
  "DISCORD_BOT_PUBLIC_KEY",
  "DISCORD_GUILD_ID",
  "DISCORD_CATEGORY_ID",
] as const;

const envars = <Record<(typeof vars)[number], string>>(
  Object.fromEntries(vars.map(v => [v, getVarValue(v)]))
);

export default envars;
