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
    color: 0xffd700,
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

export const formatGoldRecord = async (record: GoldRecord) => {
  let msg = `Total gold count is **${getGoldRecordTotal(record)}**`;
  msg += "```txt\n";
  const max = getMaxGoldRecordNameLength(record) + 5;

  for (const [name, val] of Object.entries(sortGoldRecord(record))) {
    if (name.startsWith("[")) {
      msg += `(${keyStringToPos(name).join(", ")})`.padEnd(max, ".") + val;
    } else {
      msg += `${await InGameNameCache.get(name)}`.padEnd(max, ".") + val;
    }
    msg += "\n";
  }

  msg += "```";
  return msg;
};
