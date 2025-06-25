import { ChannelTypes } from "npm:@discordeno/bot@19.0.0";
import envars from "../util/envars.ts";
import kv from "../util/kv.ts";
import { sanitiseServerIdentifier } from "../util/misc.ts";
import BOT from "./index.ts";

type ChannelEntry = Record<"channelId" | "messageId", string>;

export default class DiscordChannelTracker {
  static async _kvGetChannel(serverIdentifier: string) {
    const res = await kv.get(["channels", serverIdentifier]);
    return res.value as ChannelEntry | undefined;
  }

  static async _kvAddChannel(
    serverIdentifier: string,
    channel: ChannelEntry
  ): Promise<void> {
    await kv.set(["channels", serverIdentifier], channel);
  }

  static async _discordCreateChannel(name: string) {
    const res = await BOT.rest.createChannel(envars.DISCORD_GUILD_ID, {
      type: ChannelTypes.GuildText,
      name: sanitiseServerIdentifier(name),
      parentId: envars.DISCORD_CATEGORY_ID,
    });
    return res.id;
  }

  static async _discordCreateMessage(channelId: string) {
    const res = await BOT.rest.sendMessage(channelId, { content: "." });
    return res.id;
  }

  static async _discordChannelExists(channel: ChannelEntry) {
    return !!(await BOT.rest.getMessage(channel.channelId, channel.messageId));
  }

  static async _discordSetMessage(channel: ChannelEntry, content: string) {
    await BOT.rest.editMessage(channel.channelId, channel.messageId, {
      content,
    });
  }

  static async _acquireChannelEntry(
    serverIdentifier: string
  ): Promise<ChannelEntry> {
    const channel = await this._kvGetChannel(serverIdentifier);
    let channelId: string;
    let messageId: string;

    if (!channel || !(await this._discordChannelExists(channel))) {
      channelId = await this._discordCreateChannel(serverIdentifier);
      messageId = await this._discordCreateMessage(channelId);
      await this._kvAddChannel(serverIdentifier, { channelId, messageId });
    } else {
      channelId = channel.channelId;
      messageId = channel.messageId;
    }

    return { channelId, messageId };
  }

  static async update(
    serverIdentifier: string,
    data: { [key: string]: number }
  ) {
    const channel = await this._acquireChannelEntry(serverIdentifier);

    await this._discordSetMessage(channel, JSON.stringify(data));
  }
}
