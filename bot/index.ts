import { createBot } from "npm:@discordeno/bot@19.0.0";
import chalk from "npm:chalk";
import envars from "../util/envars.ts";

const BOT = createBot({
  token: envars.DISCORD_BOT_TOKEN,
  events: {
    ready: (_, rawPayload) =>
      console.log(
        chalk.green(
          `Ready! Logged in as ${rawPayload.user.username} (${rawPayload.user.id})`
        )
      ),
  },
});

export default BOT;
