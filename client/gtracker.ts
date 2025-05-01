/**
 * Gold pool tracker
 *
 * Synchronise a pool of gold between multiple players, independent of the world.
 *
 * A player's gold count consists of their ender chest and inventory, while other
 * containers (which must be declared) are a separate entity.
 */

if (Player.getGameMode() === "creative") throw new Error("You cannot use this script in creative.");
if (
  World.getCurrentServerAddress()
    .toString()
    .match(/local:\w:[a-zA-Z0-9]{8,}/)
)
  throw new Error("You cannot use this script in singleplayer.");
const DEBUG = false;

const DENO_API = "https://gtracker.deno.dev/api/";
const UUID_API = "https://sessionserver.mojang.com/session/minecraft/profile/";

const UPDATE_TOKEN = "";
const WIPE_TOKEN = "";

// You can change this to whatever you like
const GOLD_WEIGHTINGS = Object.fromEntries(
  Object.entries({
    "gold_block": 9,
    "raw_gold_block": 9,
    "gold_ore": 1,
    "deepslate_gold_ore": 1,
    "nether_gold_ore": 1,
    "raw_gold": 1,
    "gold_ingot": 1,
    "gold_nugget": 0.1,
  }).map(([k, v]) => [`minecraft:${k}`, v])
);
const GOLD_LIKE = Object.keys(GOLD_WEIGHTINGS);

const mfuncs = {
  updateGold(inv: Inventory) {
    this.mainGoldCount = getGoldCount(inv);
    this.contGoldCount = getGoldCount(inv, true);
  },
};
type BaseChestMemory = { wasOpen: boolean; mainGoldCount: number; contGoldCount: number } & typeof mfuncs;
const ecm: BaseChestMemory = {
  wasOpen: false,
  mainGoldCount: 0,
  contGoldCount: 0,
  ...mfuncs,
};
const scm: BaseChestMemory & { wasSlotDropped: boolean; contPos: Pos } = {
  wasOpen: false,
  wasSlotDropped: false,
  mainGoldCount: 0,
  contGoldCount: 0,
  contPos: [0, 0, 0],
  ...mfuncs,
};

const h2d = Hud.createDraw2D();
const h2d_scale = 0.9;
let d3d = Hud.createDraw3D();

let records: { [key: string]: number } = {};
let recordsWithInGameNames: { [key: string]: number } = {}; // excludes gold storage keys
let pushCooldown = 0;
let currentAttackedBlock: BlockDataHelper = null;

const CONFIG_DEFAULTS: {
  echestGoldCount: number;
  verbose: boolean;
  pushCooldownDurationSeconds: number;
  pullIntervalSeconds: number;
  inGameNameMap: { [key: string]: string };
  declaredGoldStorages: { type: "singleChest" | "barrel"; coords: [number, number, number]; count: number }[];
} = {
  echestGoldCount: 0,
  verbose: false,
  pushCooldownDurationSeconds: 20,
  pullIntervalSeconds: 60,
  inGameNameMap: {},
  declaredGoldStorages: [],
};
const CONFIG_WORLD_SPECIFIC = ["declaredGoldStorages", "echestGoldCount"] as const;

type ConfigDefaults = typeof CONFIG_DEFAULTS;
type ConfigWorldSpecificValue = (typeof CONFIG_WORLD_SPECIFIC)[number];
type ConfigShape = Omit<ConfigDefaults, ConfigWorldSpecificValue> & {
  [worldIdentifier: string]: { [P in ConfigWorldSpecificValue]: ConfigDefaults[P] };
};
type Pos = [number, number, number];

const COLOURS = {
  gold: 0xcc990e,
  red: 0xff0000,
};

class FileSys {
  static readData = <T = ConfigShape>(retry = true): T => {
    try {
      return JSON.parse(FS.open("gtracker.json").read());
    } catch {
      if (retry) {
        FileSys.makeFreshConfig();
        return FileSys.readData(false);
      }
    }
  };

  static writeData = <T = ConfigShape>(data: T) => {
    FS.open("gtracker.json").write(JSON.stringify(data, null, 2));
  };

  static makeFreshConfig = () => {
    const cfg = {};
    const id = getWorldIdentifier();
    cfg[id] = {};
    for (const [key, val] of Object.entries(CONFIG_DEFAULTS)) {
      if (CONFIG_WORLD_SPECIFIC.includes(key as ConfigWorldSpecificValue)) {
        cfg[id][key] = val;
      } else {
        cfg[key] = val;
      }
    }
    FileSys.writeData(<ConfigShape>cfg);
  };

  static makeWorldSpecificDefaults = () => {
    const data = FileSys.readData();
    const id = getWorldIdentifier();
    //@ts-expect-error Required values are assigned in for loop
    data[id] = {};
    for (const [key, val] of Object.entries(CONFIG_DEFAULTS)) {
      if (CONFIG_WORLD_SPECIFIC.includes(key as ConfigWorldSpecificValue)) {
        data[getWorldIdentifier()][key] = val;
      }
    }
    FileSys.writeData(data);
  };

  static getConfigValue = <K extends keyof ConfigDefaults>(key: K): ConfigDefaults[K] => {
    //@ts-expect-error Could be fixed by not defining it with the `as const` declaration,
    // but then I can't use it to construct `ConfigShape`. It works fine though.
    if (CONFIG_WORLD_SPECIFIC.includes(key)) {
      const val = FileSys.readData()[getWorldIdentifier()]?.[key as keyof typeof CONFIG_WORLD_SPECIFIC];
      if (val === undefined) {
        FileSys.makeWorldSpecificDefaults();
      }
      return (
        FileSys.readData()[getWorldIdentifier()]?.[key as keyof typeof CONFIG_WORLD_SPECIFIC] ?? CONFIG_DEFAULTS[key]
      );
    }
    // World-specific properties have already been handled, so ConfigShape[key] is ConfigDefaults[K]
    return (FileSys.readData()?.[key] as unknown as ConfigDefaults[K]) ?? CONFIG_DEFAULTS[key];
  };

  static setConfigValue = <K extends keyof ConfigDefaults, V extends ConfigDefaults[K]>(key: K, val: V) => {
    //@ts-expect-error see above
    if (CONFIG_WORLD_SPECIFIC.includes(key)) {
      FileSys.writeData({
        ...FileSys.readData(),
        [getWorldIdentifier()]: {
          ...FileSys.readData()[getWorldIdentifier()],
          [key]: val,
        },
      });
    } else {
      FileSys.writeData({ ...FileSys.readData(), [key]: val });
    }
  };

  static writeGoldStorageCount = (pos: Pos, count: number) => {
    const declared = FileSys.getConfigValue("declaredGoldStorages");
    declared[declared.findIndex((val) => JSON.stringify(val.coords) === JSON.stringify(pos))].count = count;
    FileSys.setConfigValue("declaredGoldStorages", declared);
    declaredGoldStorages = declared;
  };

  static readGoldStorageCount = (pos: Pos): number => {
    return declaredGoldStorages[
      declaredGoldStorages.findIndex((val) => JSON.stringify(val.coords) === JSON.stringify(pos))
    ].count;
  };
}

const getWorldIdentifier = () => {
  return World.getWorldIdentifier().toString();
};
if (!getWorldIdentifier() || getWorldIdentifier() === "UNKNOWN_NAME")
  throw new Error("Your world has no identification.");

let pushCooldownDuration = FileSys.getConfigValue("pushCooldownDurationSeconds") * 1000;
let pullIntervalInTicks = FileSys.getConfigValue("pullIntervalSeconds") * 20;
let declaredGoldStorages = FileSys.getConfigValue("declaredGoldStorages");

h2d.setOnInit(
  JavaWrapper.methodToJava((d) => {
    let x = 5;
    let y = 75;
    const { compiled, totalGoldCount } = compileFormattedGoldData();
    if (!compiled.length) return d.addText("No gold records available", x, y, COLOURS.red, true).setScale(h2d_scale);
    d.addText(`gtracker (${totalGoldCount}g)`, x, y, COLOURS.gold, true).setScale(h2d_scale);
    for (const [name, gold] of compiled) {
      y += 12;
      d.addText(
        Chat.createTextHelperFromJSON(
          JSON.stringify(["", { "text": `${name}: ` }, { "text": `${gold}g`, "color": "#cc990e" }])
        ),
        x,
        y,
        0xffffff,
        true
      ).setScale(h2d_scale);
    }
  })
);

const updateDeclaredGoldStorageD3D = () => {
  Hud.clearDraw3Ds();
  d3d = Hud.createDraw3D();
  declaredGoldStorages.map(({ coords }) => {
    d3d.addBox(
      coords[0],
      coords[1],
      coords[2],
      coords[0] + 1,
      coords[1] + 1,
      coords[2] + 1,
      COLOURS.gold,
      300,
      COLOURS.gold,
      25,
      true
    );
  });
  d3d.register();
};

const log = (msg: string, colour = 0xf, forVerboseMode = false) => {
  if (forVerboseMode && !FileSys.getConfigValue("verbose")) return;

  Chat.log(
    Chat.createTextBuilder()
      .append("[")
      .withColor(0x7)
      .append("GTK")
      .withColor(0xe)
      .append("]")
      .withColor(0x7)
      .append(` ${msg}`)
      .withColor(colour)
      .build()
  );
};

const getNameFromUUID = (uuid: string): string => {
  try {
    return JSON.parse(Request.get(UUID_API + uuid).text()).name ?? uuid;
  } catch {
    return uuid;
  }
};

const resolveInGameNames = () => {
  const inGameNameMap = FileSys.getConfigValue("inGameNameMap");
  recordsWithInGameNames = {
    ...Object.fromEntries(
      Object.entries(records)
        .filter(([uuid]) => !uuid.startsWith("["))
        .map(([uuid, goldCount]) => {
          let name: string;
          if (!(uuid in inGameNameMap)) {
            name = getNameFromUUID(uuid);
            inGameNameMap[uuid] = name;
          } else {
            name = inGameNameMap[uuid];
          }
          return [name, goldCount];
        })
    ),
  };
  FileSys.setConfigValue("inGameNameMap", inGameNameMap);
  h2d.register();
};

const compileFormattedGoldData = () => {
  const compiled = Object.entries({
    ...recordsWithInGameNames,
    ...Object.fromEntries(Object.entries(records).filter(([uuid]) => uuid.startsWith("["))),
  }).sort((a, b) => b[1] - a[1]);
  const totalGoldCount = compiled.reduce((acc, val) => acc + val[1], 0);
  return { compiled, totalGoldCount };
};

const isLookingAtGoldStorage = () => {
  const rtb = Player.getPlayer().rayTraceBlock(Player.getReach(), false);
  if (!rtb) return false;

  const pos = <Pos>[rtb.getX(), rtb.getY(), rtb.getZ()];
  if (declaredGoldStorages.find(({ coords }) => JSON.stringify(coords) === JSON.stringify(pos))) {
    return pos;
  }
  return false;
};

const declaredGoldStorageToKeyString = (pos: Pos) => {
  return `[C@${pos.join(",")}]`;
};

const getGoldCache = () => GlobalVars.getDouble("gtracker.gcache") ?? 0;

const setGoldCache = (amount: number) => GlobalVars.putDouble("gtracker.gcache", amount);

const getAuthHeader = (token: string) => new Map([["Authorization", `Bearer ${token}`]]);

const handleInvalidRequest = (res: HTTPRequest$Response) => {
  if (res.responseCode !== 200) {
    log("Request failed. Please check your tokens.", 0xc);
    return true;
  }
  return false;
};

const pushGold = (viaCommand = false) => {
  const goldCount = getGoldCache();
  log(`↑ Pushing new gold count: ${goldCount}`, 0xf, !viaCommand);
  pushCooldown = pushCooldownDuration;
  const res = Request.post(
    DENO_API + "update",
    JSON.stringify({
      serverIdentifier: getWorldIdentifier(),
      data: { uuid: Player.getPlayer().getUUID().toString(), goldCount },
    }),
    //@ts-expect-error Works
    getAuthHeader(UPDATE_TOKEN)
  );
  if (handleInvalidRequest(res)) return;
  pullGold();
};

const pushGoldStorage = (pos: Pos, count: number) => {
  const str = declaredGoldStorageToKeyString(pos);
  log(`↑ Pushing new gold count: ${count} to ${str}`, 0xf, true);
  const res = Request.post(
    DENO_API + "update",
    JSON.stringify({
      serverIdentifier: getWorldIdentifier(),
      data: { uuid: str, goldCount: count },
    }),
    //@ts-expect-error Works
    getAuthHeader(UPDATE_TOKEN)
  );
  handleInvalidRequest(res);
};

const wipeGoldStorage = (pos: Pos) => {
  const str = declaredGoldStorageToKeyString(pos);
  const res = Request.post(
    DENO_API + "wipe",
    JSON.stringify({
      type: "single",
      key: [getWorldIdentifier(), str],
    }),
    //@ts-expect-error Works
    getAuthHeader(WIPE_TOKEN)
  );
  if (handleInvalidRequest(res)) return;
  pullGold();
};

const pullGold = (viaCommand = false) => {
  log("↓ Pulling gold", 0xf, !viaCommand);
  JavaWrapper.methodToJavaAsync(resolveInGameNames).run();
  records = JSON.parse(Request.get(DENO_API + "records").text())[getWorldIdentifier()] ?? {};
  h2d.register();
};

const updateGoldCount = (force = false, viaCommand = false) => {
  if (pushCooldown && !force) {
    log(`Cannot push as cooldown still has ${pushCooldown / 1000} seconds remaining.`, 0xc, !viaCommand);
    return false;
  }
  const mainGoldCount = getGoldCount();
  const echestGoldCount = FileSys.getConfigValue("echestGoldCount");
  const totalGoldCount = mainGoldCount + echestGoldCount;
  setGoldCache(totalGoldCount);
  pushGold(viaCommand);
};

const getGoldCount = (inv: Inventory = null, container = false, slots: number[] = null) => {
  inv ??= Player.openInventory();
  slots ??= container ? [...inv.getSlots("container")] : [...inv.getSlots("main"), ...inv.getSlots("hotbar")];

  let count = 0;

  for (const slot of slots) {
    const weight = GOLD_WEIGHTINGS[inv.getSlot(slot).getItemId()];
    if (!weight) continue;
    count += weight * inv.getSlot(slot).getCount();
  }

  return count;
};

const itemPickupListener = JsMacros.on(
  "ItemPickup",
  JavaWrapper.methodToJavaAsync((ctx) => {
    const id = ctx.item.getItemId();
    if (!GOLD_LIKE.includes(id)) return;
    const inv = Player.openInventory();
    ecm.updateGold(inv);
    scm.updateGold(inv);
    updateGoldCount();
  })
);

const dropSlotListener = JsMacros.on(
  "DropSlot",
  JavaWrapper.methodToJavaAsync((ctx) => {
    const inv = Player.openInventory();
    if (ctx.slot === -999) return;
    const slot = inv.getSlot(ctx.slot);
    if (slot.getCount() === 0 || GOLD_LIKE.includes(slot.getItemId())) {
      if ([...inv.getSlots("container")].includes(ctx.slot)) {
        if (inv.getContainerTitle() === "Ender Chest") {
          DEBUG && log("Handle echest slot drop", 0xf, true);
          ecm.updateGold(inv);
          FileSys.setConfigValue("echestGoldCount", ecm.contGoldCount);
        } else {
          DEBUG && log("Handle shared gold storage slot drop", 0xf, true);
          const pos = isLookingAtGoldStorage();
          if (!pos) return log("Shared gold storage not declared", 0xc, true);
          scm.updateGold(inv);
          scm.wasSlotDropped = true;
          FileSys.writeGoldStorageCount(pos, scm.contGoldCount);
        }
      } else {
        updateGoldCount();
      }
    }
  })
);

const openContainerListener = JsMacros.on(
  "OpenContainer",
  JavaWrapper.methodToJavaAsync((ctx) => {
    const containerTitle = ctx.inventory.getContainerTitle();

    if (!containerTitle || containerTitle === "Crafting") return;
    if (containerTitle === "Ender Chest") {
      ecm.updateGold(ctx.inventory);
      ecm.wasOpen = true;
    } else {
      DEBUG && log("Handle shared gold storage", 0xf, true);
      const pos = isLookingAtGoldStorage();
      if (!pos) return log("Shared gold storage not declared", 0xc, true);
      scm.updateGold(ctx.inventory);
      scm.contPos = [...pos];
      scm.wasOpen = true;
    }
  })
);

const closeContainerListener = JsMacros.on(
  "OpenScreen",
  JavaWrapper.methodToJavaAsync((ctx) => {
    if (!ctx.screenName && ecm.wasOpen) {
      ecm.wasOpen = false;
      const currentMainGoldCount = getGoldCount();
      let redistributed = true;
      if (currentMainGoldCount < ecm.mainGoldCount) {
        // Player moved items from main -> container, so add the difference between the original and current main count to find the value
        FileSys.setConfigValue("echestGoldCount", ecm.contGoldCount + (ecm.mainGoldCount - currentMainGoldCount));
      } else if (currentMainGoldCount > ecm.mainGoldCount) {
        // Same as above, but items were moved from container -> main
        FileSys.setConfigValue(
          "echestGoldCount",
          ecm.contGoldCount - Math.abs(ecm.mainGoldCount - currentMainGoldCount)
        );
      } else {
        // No items were moved, but some items could be in there that weren't accounted for, so update in that case.
        redistributed = false;
        if (FileSys.getConfigValue("echestGoldCount") !== ecm.contGoldCount) {
          FileSys.setConfigValue("echestGoldCount", ecm.contGoldCount);
          DEBUG && log("Updating echest gold count, despite no redistribution. ", 0xf, true);
        }
      }
      const totalGoldCount = ecm.mainGoldCount + ecm.contGoldCount;
      if (getGoldCache() === totalGoldCount) {
        DEBUG &&
          log(
            `No need to push new count${redistributed ? ", but the echest/inventory was redistributed." : "."}`,
            0xf,
            true
          );
      } else {
        setGoldCache(totalGoldCount);
        updateGoldCount();
      }
    } else if (!ctx.screenName && scm.wasOpen) {
      scm.wasOpen = false;
      let redistributed = true;
      const currentMainGoldCount = getGoldCount();
      if (currentMainGoldCount < scm.mainGoldCount) {
        FileSys.writeGoldStorageCount(scm.contPos, scm.contGoldCount + (scm.mainGoldCount - currentMainGoldCount));
      } else if (currentMainGoldCount > scm.mainGoldCount) {
        FileSys.writeGoldStorageCount(
          scm.contPos,
          scm.contGoldCount - Math.abs(scm.mainGoldCount - currentMainGoldCount)
        );
      } else {
        if (FileSys.readGoldStorageCount(scm.contPos) !== scm.contGoldCount) {
          FileSys.writeGoldStorageCount(scm.contPos, scm.contGoldCount);
          DEBUG && log("Updating shared storage gold count, despite no redistribution.", 0xf, true);
        } else {
          DEBUG && log("No shared gold storage update, but slot drop flag may be true.", 0xf, true);
          redistributed = false;
        }
      }

      if (redistributed || scm.wasSlotDropped) {
        // Should a cooldown be added to pushing gold storage?
        scm.wasSlotDropped = false;
        pushGoldStorage(scm.contPos, FileSys.readGoldStorageCount(scm.contPos));
        updateGoldCount(true);
      }
    }
  })
);

const attackBlockListener = JsMacros.on(
  "AttackBlock",
  JavaWrapper.methodToJavaAsync((evt) => {
    currentAttackedBlock = evt.block;
  })
);

const breakStorageListener = JsMacros.on(
  "SendPacket",
  JsMacros.createEventFilterer("SendPacket").setType("PlayerActionC2SPacket"),
  JavaWrapper.methodToJavaAsync((evt) => {
    if (evt.packet.method_12363().toString() === "STOP_DESTROY_BLOCK") {
      const declared = FileSys.getConfigValue("declaredGoldStorages");
      const blockPos = currentAttackedBlock.getBlockPos();
      const pos = <Pos>[blockPos.getX(), blockPos.getY(), blockPos.getZ()];
      if (declared.find((val) => JSON.stringify(val.coords) === JSON.stringify(pos))) {
        Chat.say(`/gtk goldStorage renounce ${pos.join(" ")}`);
        wipeGoldStorage(pos);
      }
    }
  })
);

const tickListener = JsMacros.on(
  "Tick",
  JavaWrapper.methodToJavaAsync(() => {
    if (pushCooldown) pushCooldown -= 50;
    if (World.getTime() % pullIntervalInTicks) return;

    pullGold();
  })
);

const chunkLoadListener = JsMacros.on("ChunkLoad", JavaWrapper.methodToJavaAsync(updateDeclaredGoldStorageD3D));

const cmd = Chat.getCommandManager()
  .createCommandBuilder("gtk")
  .literalArg("push")
  .executes(JavaWrapper.methodToJavaAsync(() => updateGoldCount(false, true)))
  .or(0)
  .literalArg("forcePush")
  .executes(JavaWrapper.methodToJavaAsync(() => updateGoldCount(true, true)))
  .or(0)
  .literalArg("pull")
  .executes(JavaWrapper.methodToJavaAsync(() => pullGold(true)))
  .or(0)
  .literalArg("config")
  .literalArg("verbose")
  .executes(
    JavaWrapper.methodToJavaAsync(() => {
      const verbose = FileSys.getConfigValue("verbose");
      FileSys.setConfigValue("verbose", !verbose);
      log(`Verbose mode toggled ${!verbose ? "on" : "off"}`);
    })
  )
  .or(2)
  .literalArg("pushCooldownDurationSeconds")
  .executes(
    JavaWrapper.methodToJavaAsync(() => {
      log(`Current value is ${pushCooldownDuration / 1000}`);
    })
  )
  .literalArg("set")
  .intArg("val")
  .executes(
    JavaWrapper.methodToJavaAsync((ctx) => {
      const val = ctx.getArg("val");
      pushCooldownDuration = val * 1000;
      FileSys.setConfigValue("pushCooldownDurationSeconds", val);
      pushCooldown = 0;
      log(`Set value to ${val}`);
    })
  )
  .or(3)
  .literalArg("reset")
  .executes(
    JavaWrapper.methodToJavaAsync(() => {
      const val = CONFIG_DEFAULTS.pushCooldownDurationSeconds;
      FileSys.setConfigValue("pushCooldownDurationSeconds", val);
      pushCooldown = 0;
      log(`Reset value to ${val}`);
    })
  )
  .or(2)
  .literalArg("pullIntervalSeconds")
  .executes(
    JavaWrapper.methodToJavaAsync(() => {
      log(`Current value is ${pullIntervalInTicks / 20}`);
    })
  )
  .literalArg("set")
  .intArg("val")
  .executes(
    JavaWrapper.methodToJavaAsync((ctx) => {
      const val = ctx.getArg("val");
      pullIntervalInTicks = val * 20;
      FileSys.setConfigValue("pullIntervalSeconds", val);
      log(`Set value to ${val}`);
    })
  )
  .or(3)
  .literalArg("reset")
  .executes(
    JavaWrapper.methodToJavaAsync(() => {
      const val = CONFIG_DEFAULTS.pullIntervalSeconds;
      FileSys.setConfigValue("pullIntervalSeconds", val);
      log(`Reset value to ${val}`);
    })
  )
  .or(2)
  .literalArg("inGameNameMap")
  .executes(
    JavaWrapper.methodToJavaAsync(() => {
      log(`Current value is ${JSON.stringify(FileSys.getConfigValue("inGameNameMap"))}`);
    })
  )
  .literalArg("reset")
  .executes(
    JavaWrapper.methodToJavaAsync(() => {
      FileSys.setConfigValue("inGameNameMap", {});
      log(`Reset value to {}`);
    })
  )
  .or(0)
  .literalArg("goldStorage")
  .literalArg("declare")
  .blockPosArg("pos")
  .executes(
    JavaWrapper.methodToJavaAsync((ctx) => {
      const pos = ctx.getArg("pos");

      const block = World.getBlock(pos.toPos3D());
      if (!block) return log("This block is not loaded", 0xc);
      const blockPos = block.getBlockPos();
      const blockPosArr: Pos = [blockPos.getX(), blockPos.getY(), blockPos.getZ()];
      const id = block.getId().toString();

      const chestType = block.getBlockState()?.get("type");
      if (!(["minecraft:barrel", "minecraft:chest"].includes(id) || chestType === "single")) {
        return log("Currently, only single chests or barrels are accepted as shared gold storages.", 0x6);
      }

      const declared = FileSys.getConfigValue("declaredGoldStorages");
      if (declared.find((val) => JSON.stringify(val.coords) === JSON.stringify(blockPosArr))) {
        return log("This container has already been declared.", 0xc);
      }

      declared.push({ type: chestType ? "singleChest" : "barrel", coords: blockPosArr, count: 0 });
      FileSys.setConfigValue("declaredGoldStorages", declared);
      declaredGoldStorages = declared;
      updateDeclaredGoldStorageD3D();
      log("Declared this storage", 0xa);
    })
  )
  .or(2)
  .literalArg("renounce")
  .blockPosArg("pos")
  .suggest(
    JavaWrapper.methodToJava((_, b) =>
      b.suggestMatching(FileSys.getConfigValue("declaredGoldStorages").map((val) => val.coords.join(" ")))
    )
  )
  .executes(
    JavaWrapper.methodToJavaAsync((ctx) => {
      const pos = ctx.getArg("pos");

      const block = World.getBlock(pos.toPos3D());
      if (!block) return log("This block is not loaded", 0xc);
      const blockPos = block.getBlockPos();
      const blockPosArr = [blockPos.getX(), blockPos.getY(), blockPos.getZ()];

      let declared = FileSys.getConfigValue("declaredGoldStorages");
      if (!declared.find((val) => JSON.stringify(val.coords) === JSON.stringify(blockPosArr))) {
        return log("This container has not been declared.", 0xc);
      }

      declared = declared.filter((val) => JSON.stringify(val.coords) !== JSON.stringify(blockPosArr));
      FileSys.setConfigValue("declaredGoldStorages", declared);
      declaredGoldStorages = declared;
      updateDeclaredGoldStorageD3D();
      log("Renounced this storage", 0xa);
    })
  )
  .register();

log("Initialised gtracker! Command prefix is gtk.", 0xa);
setGoldCache(getGoldCount() + FileSys.getConfigValue("echestGoldCount"));
updateGoldCount(true, true);
updateDeclaredGoldStorageD3D();
h2d.register();

//@ts-expect-error Intended usage
event.stopListener = JavaWrapper.methodToJava(() => {
  JsMacros.off(itemPickupListener);
  JsMacros.off(dropSlotListener);
  JsMacros.off(openContainerListener);
  JsMacros.off(closeContainerListener);
  JsMacros.off(chunkLoadListener);
  JsMacros.off(tickListener);
  JsMacros.off(attackBlockListener);
  JsMacros.off(breakStorageListener);
  cmd.unregister();
  Hud.clearDraw2Ds();
  Hud.clearDraw3Ds();
});
