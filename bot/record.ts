import { DiscordEmbed } from "npm:@discordeno/bot@19.0.0";
import { GoldRecord } from "./tracker.ts";
import { keyStringToPos } from "../util/misc.ts";
import InGameNameCache from "../util/ignCache.ts";

export const compileGoldRecordEmbed = async (
  serverIdentifier: string,
  record: GoldRecord
) => {
  return <DiscordEmbed>{
    title: `Gold record for ${serverIdentifier}`,
    color: 0xba9e61,
    description: await formatGoldRecord(record),
    footer: {
      text: "gtracker",
      icon_url:
        "https://cdn.discordapp.com/avatars/1387303493345218621/a8b48f5c040166f0e35034341aa3c27e.webp",
    },
    timestamp: new Date().toISOString(),
  };
};

const sortGoldRecord = (record: GoldRecord) =>
  Object.fromEntries(Object.entries(record).sort((a, b) => b[1] - a[1]));

const getGoldRecordTotal = (record: GoldRecord) =>
  Object.entries(record).reduce((acc, val) => acc + val[1], 0);

const formatGoldRecordEntries = async (record: GoldRecord) => {
  const entries: [string, string][] = [];

  for (const [name, val] of Object.entries(record)) {
    const formattedName = name.startsWith("[")
      ? `(${keyStringToPos(name).join(", ")})`
      : await InGameNameCache.get(name);
    entries.push([formattedName, val.toString()]);
  }

  return entries;
};

const formatGoldRecord = async (record: GoldRecord) => {
  const formattedEntries = await formatGoldRecordEntries(
    sortGoldRecord(record)
  );
  const maxName =
    Math.max(...formattedEntries.map(([name]) => name.length)) + 5;
  const maxVal = Math.max(...formattedEntries.map(([, val]) => val.length));

  let msg = `Total gold count is **${getGoldRecordTotal(record)}**`;
  msg += "```txt\n";

  for (const [name, val] of formattedEntries) {
    msg += name.padEnd(maxName, ".") + val.padStart(maxVal, ".") + "\n";
  }

  msg += "```";
  return msg;
};
