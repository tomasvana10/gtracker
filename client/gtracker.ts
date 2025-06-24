/**
 * Gold pool tracker
 *
 * Synchronise a pool of gold between multiple players, independent of the world.
 *
 * A player's gold count consists of their ender chest and inventory, while other
 * containers (which must be declared) are a separate entity.
 */

const DEBUG = false;

const extractPosFromKeyStringRegex = /\[C@(\d+,\d+,\d+)\]/;

const DENO_API = "https://gtracker.deno.dev/api/";
const UUID_API = "https://sessionserver.mojang.com/session/minecraft/profile/";

const UPDATE_TOKEN = "yTmxQAVbxi2jzRKt07gOWjeiFl7IvB9o";
const WIPE_TOKEN = "FfFUUkIhl0y5qZaEiX1jI2x2To5fx4A6";

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
  }).map(([key, val]) => [`minecraft:${key}`, val])
);
const GOLD_LIKE = Object.keys(GOLD_WEIGHTINGS);
const VALID_GOLD_STORAGES = ["barrel", "chest"].map((val) => `minecraft:${val}`);
const DOCS = [
  {
    cmd: "config <key> [set <value> | reset]",
    desc: "Set the value of or reset the given configuration key",
  },
  {
    cmd: "config <key>",
    desc: "Get or toggle the given configuration key.",
  },
  { cmd: "forcePush", desc: "Push your gold to the server, disregarding any cooldowns." },
  {
    cmd: "gstorage declare <x> <y> <z>",
    desc: "Declare a gold storage, adding it on your client. It will be added to the server once you provide it with gold.",
  },
  { cmd: "gstorage renounce <x> <y> <z>", desc: "Remove a gold storage from the client and the server." },
  { cmd: "pull", desc: "Get the most up-to-date gold records for your server's pool." },
  {
    cmd: "gstorage nickname <x> <y> <z> (<nickname> | null)",
    desc: "Nickname a gold storage (purely client side). Provide 'null' to remove it.",
  },
  {
    cmd: "push",
    desc: "Push your gold to the server if a cooldown isn't active.",
  },
  { cmd: "sync", desc: "Synchronise gold storages between your client and the server." },
].sort((a, b) => a.cmd.localeCompare(b.cmd));

// util funcs for chest memory objects
const mfuncs = {
  updateGold(inv: Inventory) {
    this.mainGoldCount = getGoldCount(inv);
    this.contGoldCount = getGoldCount(inv, true);
  },
};
type BaseChestMemory = { wasOpen: boolean; mainGoldCount: number; contGoldCount: number } & typeof mfuncs;
// echest memory
const ecm: BaseChestMemory = {
  wasOpen: false,
  mainGoldCount: 0,
  contGoldCount: 0,
  ...mfuncs,
};
// shared container memory
const scm: BaseChestMemory & { wasSlotDropped: boolean; contPos: Pos; wasNotDeclared: boolean } = {
  wasOpen: false,
  wasNotDeclared: false,
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
  verbose: boolean;
  pushCooldownDurationSeconds: number;
  pullIntervalSeconds: number;
  inGameNameMap: { [key: string]: string };
  echestGoldCount: number;
  declaredGoldStorages: {
    [key: PosString]: { type: "singleChest" | "barrel"; count: number; nickname: null | string };
  };
  goldRecordEntryLimit: number;
} = {
  verbose: false,
  pushCooldownDurationSeconds: 10,
  pullIntervalSeconds: 60,
  inGameNameMap: {},
  echestGoldCount: 0,
  declaredGoldStorages: {},
  goldRecordEntryLimit: 5,
};
const CONFIG_WORLD_SPECIFIC = ["declaredGoldStorages", "echestGoldCount"] as const;

type ConfigDefaults = typeof CONFIG_DEFAULTS;
type ConfigWorldSpecificValue = (typeof CONFIG_WORLD_SPECIFIC)[number];
type GenericConfigShape = Omit<ConfigDefaults, ConfigWorldSpecificValue>;
type WorldConfigShape = {
  [worldIdentifier: string]: { [P in ConfigWorldSpecificValue]: ConfigDefaults[P] };
};
type Pos = [number, number, number];
type PosString = `${number},${number},${number}`;
type ConfigShape = GenericConfigShape | WorldConfigShape;

const COLOURS = {
  gold: 0xcc990e,
  red: 0xff0000,
};

class FileSys {
  static JSON_DIR = "json";
  static GENERIC_CONFIG_FILENAME = "config.json";
  static WORLD_CONFIG_FILENAME = "worlds.json";

  static readData = <T extends ConfigShape>(generic: boolean, retry = true): T => {
    try {
      return JSON.parse(FS.open(filename(generic)).read());
    } catch {
      if (retry) {
        FileSys.makeFreshConfig();
        return FileSys.readData<T>(false, generic);
      }
    }
  };

  static writeData = <T extends ConfigShape>(data: T, generic: boolean) => {
    FS.open(filename(generic)).write(JSON.stringify(data, null, 2));
  };

  static makeFreshConfig = () => {
    const cfg = {};
    const id = getWorldIdentifier();
    const world = {};
    world[id] = {};
    for (const [key, val] of Object.entries(CONFIG_DEFAULTS)) {
      if (CONFIG_WORLD_SPECIFIC.includes(key as ConfigWorldSpecificValue)) {
        world[id][key] = val;
      } else {
        cfg[key] = val;
      }
    }
    FileSys.writeData(<GenericConfigShape>cfg, true);
    FileSys.writeData(<WorldConfigShape>world, false);
  };

  static makeWorldSpecificDefaults = () => {
    const data = FileSys.readData(false);
    const id = getWorldIdentifier();
    data[id] = {};
    for (const [key, val] of Object.entries(CONFIG_DEFAULTS)) {
      if (CONFIG_WORLD_SPECIFIC.includes(key as ConfigWorldSpecificValue)) {
        data[getWorldIdentifier()][key] = val;
      }
    }
    FileSys.writeData(<WorldConfigShape>data, false);
  };

  static getConfigValue = <K extends keyof ConfigDefaults>(key: K): ConfigDefaults[K] => {
    //@ts-expect-error Could be fixed by not defining it with the `as const` declaration,
    // but then I can't use it to construct `ConfigShape`. It works fine though.
    if (CONFIG_WORLD_SPECIFIC.includes(key)) {
      const val =
        FileSys.readData<WorldConfigShape>(false)[getWorldIdentifier()]?.[key as keyof typeof CONFIG_WORLD_SPECIFIC];
      if (val === undefined) {
        FileSys.makeWorldSpecificDefaults();
      }
      return (
        FileSys.readData<WorldConfigShape>(false)[getWorldIdentifier()]?.[key as keyof typeof CONFIG_WORLD_SPECIFIC] ??
        CONFIG_DEFAULTS[key]
      );
    }
    return (FileSys.readData<GenericConfigShape>(true)?.[key] as unknown as ConfigDefaults[K]) ?? CONFIG_DEFAULTS[key];
  };

  static setConfigValue = <K extends keyof ConfigDefaults, V extends ConfigDefaults[K]>(key: K, val: V) => {
    //@ts-expect-error see above
    if (CONFIG_WORLD_SPECIFIC.includes(key)) {
      const data = FileSys.readData<WorldConfigShape>(false);
      const id = getWorldIdentifier();
      FileSys.writeData<WorldConfigShape>(
        {
          ...data,
          [id]: {
            ...data[id],
            [key]: val,
          },
        },
        false
      );
    } else {
      FileSys.writeData<GenericConfigShape>({ ...FileSys.readData<GenericConfigShape>(true), [key]: val }, true);
    }
  };

  static setGoldStorageCount = (pos: Pos, count: number) => {
    const declared = FileSys.getConfigValue("declaredGoldStorages");
    declared[<PosString>pos.join(",")].count = count;
    FileSys.setConfigValue("declaredGoldStorages", declared);
    declaredGoldStorages = declared;
  };

  static getGoldStorageCount = (pos: Pos): number => {
    return declaredGoldStorages[<PosString>pos.join(",")].count;
  };

  static setGoldStorageNickname = (pos: Pos, nickname: string) => {
    const declared = FileSys.getConfigValue("declaredGoldStorages");
    declared[<PosString>pos.join(",")].nickname = nickname === "null" ? null : nickname;
    FileSys.setConfigValue("declaredGoldStorages", declared);
    declaredGoldStorages = declared;
  };
}

const updateDeclaredGoldStorages = () => {
  declaredGoldStorages = FileSys.getConfigValue("declaredGoldStorages");
};

const refresh = (viaCommand = false, noPull = false) => {
  log("🔄 Refreshing script memory and 3D overlays", 0xf, !viaCommand);
  !noPull && pullGold(true);
  updateDeclaredGoldStorages();
  updateDeclaredGoldStorageD3D();
};

const getWorldIdentifier = () => {
  return World.getWorldIdentifier().toString();
};

const showHelp = () => {
  const b = Chat.createTextBuilder();
  b.append("~$~gtracker~$~\n").withColor(0xe);
  b.append("This service synchronises a pool of gold between multiple players.\n\n");
  b.append("Commands:\n");

  for (const doc of DOCS) {
    b.append(doc.cmd).withColor(0x7).append(`: ${doc.desc}\n`);
  }
  b.append("~$~========~$~").withColor(0xe);
  Chat.log(b.build());
};

const filename = (generic: boolean) =>
  generic
    ? `${FileSys.JSON_DIR}/${FileSys.GENERIC_CONFIG_FILENAME}`
    : `${FileSys.JSON_DIR}/${FileSys.WORLD_CONFIG_FILENAME}`;

const check = () => {
  if (Player.getGameMode() === "creative") throw new Error("You cannot use gtracker in creative.");
  if (
    World.getCurrentServerAddress()
      .toString()
      .match(/local:\w:[a-zA-Z0-9]{8,}/)
  )
    throw new Error("You cannot use gtracker in singleplayer.");
  if (!getWorldIdentifier() || getWorldIdentifier() === "UNKNOWN_NAME")
    throw new Error("Your world has no identification.");
  if (!FS.exists(FileSys.JSON_DIR)) FS.makeDir(FileSys.JSON_DIR);
};

check();
let pushCooldownDuration = FileSys.getConfigValue("pushCooldownDurationSeconds") * 1000;
let pullIntervalInTicks = FileSys.getConfigValue("pullIntervalSeconds") * 20;
let declaredGoldStorages = FileSys.getConfigValue("declaredGoldStorages");
let goldRecordEntryLimit = FileSys.getConfigValue("goldRecordEntryLimit");

h2d.setOnInit(
  JavaWrapper.methodToJava((d) => {
    let x = 5;
    let y = 75;
    const { compiled, totalGoldCount } = compileFormattedGoldData();
    if (!compiled.length) return d.addText("No gold records available", x, y, COLOURS.red, true).setScale(h2d_scale);
    d.addText(`gtracker (${totalGoldCount}g)`, x, y, COLOURS.gold, true).setScale(h2d_scale);
    const sliced = compiled.slice(0, goldRecordEntryLimit);
    for (const [name, gold] of sliced) {
      const nickname = name.startsWith("[")
        ? declaredGoldStorages[<PosString>keyStringToPos(name).join(",")]?.nickname ?? name
        : name;
      y += 12;
      d.addText(
        Chat.createTextHelperFromJSON(
          JSON.stringify(["", { "text": `${nickname}: ` }, { "text": `${gold}g`, "color": "#cc990e" }])
        ),
        x,
        y,
        0xffffff,
        true
      ).setScale(h2d_scale);
    }
    y += 12;
    if (sliced.length !== compiled.length)
      d.addText(`...and ${compiled.length - sliced.length} more`, x, y, 0xffffff, true).setScale(h2d_scale);
  })
);

const distanceFrom = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) =>
  Math.hypot(x2 - x1, y2 - y1, z2 - z1);

const updateDeclaredGoldStorageD3D = () => {
  Hud.clearDraw3Ds();
  const playerPos = Player.getPlayer().getPos();
  const renderDistanceRadius = Client.getGameOptions().getVideoOptions().getRenderDistance() * 16;
  d3d = Hud.createDraw3D();
  Object.keys(declaredGoldStorages).map((c) => {
    const coords = c.split(",").map(Number);
    if (
      distanceFrom(playerPos.getX(), playerPos.getY(), playerPos.getZ(), coords[0], coords[1], coords[2]) >
      renderDistanceRadius
    )
      return;
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
  if (pos.join(",") in declaredGoldStorages) {
    return pos;
  }
  return false;
};

const posToKeyString = (pos: Pos) => {
  return `[C@${pos.join(",")}]`;
};

const keyStringToPos = (str: string) => {
  return <Pos>str
    .match(extractPosFromKeyStringRegex)[1]
    .split(",")
    .map((coord) => parseInt(coord));
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
  log(`↑ Pushing new personal gold count: ${goldCount}`, 0xf, !viaCommand);
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
  const str = posToKeyString(pos);
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

const wipeGoldStorages = (positions: Pos[]) => {
  const res = Request.post(
    DENO_API + "wipe",
    JSON.stringify({
      type: "multiple",
      serverIdentifier: getWorldIdentifier(),
      keys: positions.map((pos) => posToKeyString(pos)),
    }),
    //@ts-expect-error Works
    getAuthHeader(WIPE_TOKEN)
  );
  if (handleInvalidRequest(res)) return;
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

const synchroniseGoldStorages = (viaCommand = false) => {
  log("⇔ Synchronising gold storages", 0xf, !viaCommand);
  const serverStorages: [Pos, number][] = Object.entries(records)
    .filter(([uuid]) => uuid.startsWith("["))
    .map(([key, number]) => [keyStringToPos(key), number]);
  const clientStorages = FileSys.getConfigValue("declaredGoldStorages");
  const removedOnClient: Pos[] = [];
  const addedOnServer: [Pos, number][] = [];
  for (const [pos, goldCount] of serverStorages) {
    const block = World?.getBlock(...pos)
      ?.getId()
      .toString();
    if (block && !VALID_GOLD_STORAGES.includes(block)) {
      removedOnClient.push(pos);
    } else if (!(pos.join(",") in clientStorages)) {
      addedOnServer.push([pos, goldCount]);
    }
  }

  let shouldPull = false;

  if (removedOnClient.length) {
    DEBUG && log(`${removedOnClient.length} removed on client`);
    wipeGoldStorages(removedOnClient);
    for (const pos of removedOnClient) {
      renounceGoldStorage(null, false, pos);
    }
    shouldPull = true;
  }
  viaCommand &&
    removedOnClient.length &&
    log(`Removed ${removedOnClient.length} storage(s) from your client that were not present on the server.`);

  let notloaded = 0;
  let added = 0;

  if (addedOnServer.length) {
    DEBUG && log(`${addedOnServer.length} removed on client`);
    for (const [pos, goldCount] of addedOnServer) {
      const res = declareGoldStorage(null, false, pos);
      if (res === "notloaded") {
        notloaded++;
        continue;
      }
      added++;
      FileSys.setGoldStorageCount(pos, goldCount);
    }
    shouldPull = true;
  }
  viaCommand && added && log(`Added ${added} storage(s) from the server that were not present on your client.`);

  viaCommand &&
    notloaded &&
    log(`${notloaded} storage(s) could not be added on your client as they are not loaded.`, 0x6);
  shouldPull && pullGold();
  return shouldPull;
};

const declareGoldStorage = (ctx: Events.CommandContext = null, viaCommand: boolean, position: Pos = null) => {
  const pos = position || ctx.getArg("pos");
  const block = position ? World.getBlock(...position) : World.getBlock(pos.toPos3D());

  if (!block) {
    viaCommand && log("This block is not loaded", 0xc);
    return "notloaded";
  }
  const blockPos = block.getBlockPos();
  const blockPosArr: Pos = [blockPos.getX(), blockPos.getY(), blockPos.getZ()];
  const id = block.getId().toString();

  const chestType = block.getBlockState()?.get("type");
  if (!(VALID_GOLD_STORAGES.includes(id) || chestType === "single")) {
    return log("Only single chests or barrels are accepted as shared gold storages.", 0x6);
  }

  const declared = FileSys.getConfigValue("declaredGoldStorages");
  if (blockPosArr.join(",") in declared) {
    return log("This storage has already been declared.", 0xc);
  }

  declared[<PosString>blockPosArr.join(",")] = { type: chestType ? "singleChest" : "barrel", count: 0, nickname: null };
  FileSys.setConfigValue("declaredGoldStorages", declared);
  declaredGoldStorages = declared;
  updateDeclaredGoldStorageD3D();
  viaCommand && log("Declared this storage", 0xa);
};

const renounceGoldStorage = (ctx: Events.CommandContext = null, viaCommand: boolean, position: Pos = null) => {
  const pos = position || ctx.getArg("pos");
  const block = position ? World.getBlock(...position) : World.getBlock(pos.toPos3D());

  if (!block) {
    viaCommand && log("This block is not loaded", 0xc);
    return;
  }
  const blockPos = block.getBlockPos();
  const blockPosArr = <Pos>[blockPos.getX(), blockPos.getY(), blockPos.getZ()];

  let declared = FileSys.getConfigValue("declaredGoldStorages");
  if (!(blockPosArr.join(",") in declared)) {
    ctx && log("This storage has not been declared.", 0xc);
    return;
  }

  delete declared[blockPosArr.join(",")];
  FileSys.setConfigValue("declaredGoldStorages", declared);
  declaredGoldStorages = declared;
  updateDeclaredGoldStorageD3D();
  wipeGoldStorages([blockPosArr]);
  pullGold();
  viaCommand && log("Renounced this storage", 0xa);
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
          FileSys.setGoldStorageCount(pos, scm.contGoldCount);
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
      scm.updateGold(ctx.inventory);
      scm.wasOpen = true;
      if (!pos) {
        scm.wasNotDeclared = true;
        return log("Shared gold storage not declared", 0xc, true);
      }
      scm.contPos = [...pos];
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
      if (!scm.wasNotDeclared) {
        if (currentMainGoldCount < scm.mainGoldCount) {
          FileSys.setGoldStorageCount(scm.contPos, scm.contGoldCount + (scm.mainGoldCount - currentMainGoldCount));
        } else if (currentMainGoldCount > scm.mainGoldCount) {
          FileSys.setGoldStorageCount(
            scm.contPos,
            scm.contGoldCount - Math.abs(scm.mainGoldCount - currentMainGoldCount)
          );
        } else {
          if (FileSys.getGoldStorageCount(scm.contPos) !== scm.contGoldCount) {
            FileSys.setGoldStorageCount(scm.contPos, scm.contGoldCount);
            DEBUG && log("Updating shared storage gold count, despite no redistribution.", 0xf, true);
          } else {
            DEBUG && log("No shared gold storage update, but slot drop flag may be true.", 0xf, true);
            redistributed = false;
          }
        }
      } else {
        redistributed = false;
      }

      if (redistributed || scm.wasSlotDropped) {
        // Should a cooldown be added to pushing gold storage?
        scm.wasSlotDropped = false;
        pushGoldStorage(scm.contPos, FileSys.getGoldStorageCount(scm.contPos));
        updateGoldCount(true);
      } else if (scm.wasNotDeclared) {
        if (currentMainGoldCount !== scm.mainGoldCount) updateGoldCount(true);
        scm.wasNotDeclared = false;
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
      if (pos.join(",") in declared) {
        renounceGoldStorage(null, true, pos);
        wipeGoldStorages([pos]);
        pullGold();
      }
      synchroniseGoldStorages();
    }
  })
);

const joinWorldListener = JsMacros.on(
  "JoinServer",
  JavaWrapper.methodToJavaAsync(() => {
    Time.sleep(1000);
    check();
  })
);

const tickListener = JsMacros.on(
  "Tick",
  JavaWrapper.methodToJavaAsync(() => {
    if (pushCooldown) pushCooldown -= 50;
    if (World.getTime() % pullIntervalInTicks) return;

    pullGold();
    refresh(false, true);
    synchroniseGoldStorages();
  })
);

const chunkLoadListener = JsMacros.on("ChunkLoad", JavaWrapper.methodToJavaAsync(updateDeclaredGoldStorageD3D));

const changeDimensionListener = JsMacros.on(
  "DimensionChange",
  JavaWrapper.methodToJavaAsync(() => {
    Time.sleep(1000);
    refresh();
  })
);

const cmd = Chat.getCommandManager()
  .createCommandBuilder("gtk")
  .executes(JavaWrapper.methodToJavaAsync(showHelp))
  .literalArg("push")
  .executes(JavaWrapper.methodToJavaAsync(() => updateGoldCount(false, true)))
  .or(0)
  .literalArg("forcePush")
  .executes(JavaWrapper.methodToJavaAsync(() => updateGoldCount(true, true)))
  .or(0)
  .literalArg("help")
  .executes(JavaWrapper.methodToJavaAsync(showHelp))
  .or(0)
  .literalArg("sync")
  .executes(
    JavaWrapper.methodToJavaAsync(() => {
      refresh(true);
      synchroniseGoldStorages(true);
    })
  )
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
      pullIntervalInTicks = val * 20;
      FileSys.setConfigValue("pullIntervalSeconds", val);
      log(`Reset value to ${val}`);
    })
  )
  .or(2)
  .literalArg("goldRecordEntryLimit")
  .executes(
    JavaWrapper.methodToJavaAsync(() => {
      log(`Current value is ${goldRecordEntryLimit}`);
    })
  )
  .literalArg("set")
  .intArg("val")
  .executes(
    JavaWrapper.methodToJavaAsync((ctx) => {
      const val = ctx.getArg("val");
      goldRecordEntryLimit = val;
      FileSys.setConfigValue("goldRecordEntryLimit", val);
      h2d.register();
      log(`Set value to ${val}`);
    })
  )
  .or(3)
  .literalArg("reset")
  .executes(
    JavaWrapper.methodToJavaAsync(() => {
      const val = CONFIG_DEFAULTS.goldRecordEntryLimit;
      goldRecordEntryLimit = val;
      FileSys.setConfigValue("goldRecordEntryLimit", val);
      h2d.register();
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
  .literalArg("gstorage")
  .literalArg("declare")
  .blockPosArg("pos")
  .executes(JavaWrapper.methodToJavaAsync((ctx) => declareGoldStorage(ctx, true)))
  .or(2)
  .literalArg("renounce")
  .blockPosArg("pos")
  .suggest(
    JavaWrapper.methodToJava((_, b) =>
      b.suggestMatching(
        Object.keys(FileSys.getConfigValue("declaredGoldStorages")).map((coords) => coords.split(",").join(" "))
      )
    )
  )
  .executes(JavaWrapper.methodToJavaAsync((ctx) => renounceGoldStorage(ctx, true)))
  .or(2)
  .literalArg("nickname")
  .blockPosArg("pos")
  .suggest(
    JavaWrapper.methodToJava((_, b) =>
      b.suggestMatching(
        Object.keys(FileSys.getConfigValue("declaredGoldStorages")).map((coords) => coords.split(",").join(" "))
      )
    )
  )
  .wordArg("nickname")
  .executes(
    JavaWrapper.methodToJavaAsync((ctx) => {
      const pos = ctx.getArg("pos").toPos3D();
      const blockPos = [pos.getX(), pos.getY(), pos.getZ()];
      if (!(blockPos.join(",") in declaredGoldStorages)) return log("This storage has not been declared.", 0xc);
      FileSys.setGoldStorageNickname(<Pos>blockPos, ctx.getArg("nickname"));
      h2d.register();
      log("This storage has been nicknamed");
    })
  )
  .register();

log("Initialised gtracker! Try /gtk.", 0xa);
setGoldCache(getGoldCount() + FileSys.getConfigValue("echestGoldCount"));
updateGoldCount(true, true);
updateDeclaredGoldStorageD3D();
synchroniseGoldStorages();
h2d.register();

//@ts-expect-error Intended usage
event.stopListener = JavaWrapper.methodToJava(() => {
  JsMacros.off(itemPickupListener);
  JsMacros.off(dropSlotListener);
  JsMacros.off(openContainerListener);
  JsMacros.off(closeContainerListener);
  JsMacros.off(chunkLoadListener);
  JsMacros.off(joinWorldListener);
  JsMacros.off(tickListener);
  JsMacros.off(attackBlockListener);
  JsMacros.off(breakStorageListener);
  JsMacros.off(changeDimensionListener);
  cmd.unregister();
  Hud.clearDraw2Ds();
  Hud.clearDraw3Ds();
});
