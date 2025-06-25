import envars from "../util/envars.ts";
import kv from "../util/kv.ts";
import BOT from "./index.ts";

type ChannelEntry = Record<"channelId" | "messageId", string>;

export default class DiscordChannelTracker {
  static async _kvGetChannel(serverIdentifier: string) {
    const res = await kv.get(["channels", serverIdentifier]);
    return res.value as ChannelEntry | undefined;
  }

  static async _kvAddChannel(
    serverIdentifier: string,
    entry: ChannelEntry
  ): Promise<void> {
    await kv.set(["channels", serverIdentifier, "channelId"], entry.channelId);
    await kv.set(["channels", serverIdentifier, "messageId"], entry.messageId);
  }

  static async _discordCreateChannel(name: string) {
    const res = await BOT.rest.createChannel(envars.DISCORD_GUILD_ID, {
      name,
    });
    return res.id;
  }

  static async _discordCreateMessage(channelId: string) {
    const res = await BOT.rest.sendMessage(channelId, { content: "." });
    return res.id;
  }

  static async _discordSetMessage(entry: ChannelEntry, content: string) {
    await BOT.rest.editMessage(entry.channelId, entry.messageId, { content });
  }

  static async _acquireChannelEntry(
    serverIdentifier: string
  ): Promise<ChannelEntry> {
    const channel = await this._kvGetChannel(serverIdentifier);
    let channelId: string;
    let messageId: string;
    
    if (!channel) {
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
    const entry = await this._acquireChannelEntry(serverIdentifier);

    await this._discordSetMessage(entry, JSON.stringify(data));
  }
}
