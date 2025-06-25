import { DiscordEmbed } from "npm:@discordeno/bot@19.0.0";
import { GoldRecord } from "./tracker.ts";
import { keyStringToPos } from "../util/misc.ts";
import InGameNameCache from "../util/ignCache.ts";

export const compileGoldRecordEmbed = async (
  serverIdentifier: string,
  record: GoldRecord
) => {
  return <DiscordEmbed>{
    title: `Gold records for ${serverIdentifier}`,
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

export const sortGoldRecord = (record: GoldRecord) =>
  Object.fromEntries(Object.entries(record).sort((a, b) => b[1] - a[1]));

export const getGoldRecordTotal = (record: GoldRecord) =>
  Object.entries(record).reduce((acc, val) => acc + val[1], 0);

export const getMaxGoldRecordNameLength = (record: GoldRecord) =>
  Math.max(...Object.entries(record).map(entry => entry[0].length));

export const formatGoldRecordNames = async (record: GoldRecord) => {
  const entries: [string, string][] = [];

  for (const [name, val] of Object.entries(record)) {
    const formattedName = name.startsWith("[")
      ? `(${keyStringToPos(name).join(", ")})`
      : await InGameNameCache.get(name);
    entries.push([formattedName, val.toString()]);
  }

  return entries;
};

export const formatGoldRecord = async (record: GoldRecord) => {
  const formattedNames = await formatGoldRecordNames(sortGoldRecord(record));
  const max = Math.max(...formattedNames.map(([name]) => name.length)) + 5;

  let msg = `Total gold count is **${getGoldRecordTotal(record)}**`;
  msg += "```txt\n";

  for (const [name, val] of formattedNames) {
    msg += name.padEnd(max, ".") + val + "\n";
  }

  msg += "```";
  return msg;
};
