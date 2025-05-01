# gtracker

Client/server implementation of a gold pool tracker for Minecraft.

`gtracker` synchronises a pool of gold between multiple players, independent of the world.

A player's gold count consists of their ender chest and inventory, while other containers (which must be declared) are a separate entity.

**Note**: You can rewrite the client-side implementation to track any item you want.

### Usage

1. Host `main.ts` on the platform of your choice. I chose [Deno Deploy](https://deno.com/deploy).
2. Add two tokens to your environment: `UPDATE_TOKEN` and `WIPE_TOKEN`.
3. Run `client/gtracker.js` as a service in JSMacros. If you are unsure how to use JSMacros, visit [its website](https://jsmacros.wagyourtail.xyz/).

## For developers
### Modifying the code
Download `typescript-main.zip` from the [JSMacros release](https://github.com/JsMacros/JsMacros/releases/tag/1.9.2). You may want to modify `client/tsconfig.json` to properly include these files.


### API Reference

`/api/update`

- Methods: `POST`
- Authorisation required: Yes

**Example request body**

```json
{
  "serverIdentifier": "mc.hypixel.net",
  "data": {
    "uuid": "4d3e986c-9695-4fa4-945c-ac00d101c524",
    "goldCount": 420
  }
}
```

<br>

`/api/wipe`

- Methods: `POST`
- Authorisation required: Yes

**Example request body**

```json
{
  "key": ["mc.hypixel.net", "4d3e986c-9695-4fa4-945c-ac00d101c524"],
  "type": "single"
}
```

Replace `single` with `all` to wipe all entries from the record (a key is not required in this case).

<br>

`/api/records`

- Methods: `GET`
- Authorisation required: No

**Example response**

```json
{
  "mc.hypixel.net": {
    "[C@100,91,6969]": 62,
    "4d3e986c-9695-4fa4-945c-ac00d101c524": 4164.1
  },
  "other.server.net": {
    "2aea82aa-d8fa-4be1-a48a-e3fb0eeb8ad5": 1234
  }
}
```
