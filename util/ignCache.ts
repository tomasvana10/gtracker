export default class InGameNameCache {
  private static API =
    "https://sessionserver.mojang.com/session/minecraft/profile/";
  static cache: Map<string, string> = new Map();

  static async _computeName(uuid: string) {
    return await fetch(this.API + uuid)
      .then(res => (res.ok ? res.json() : Promise.reject()))
      .then(json => json?.name ?? uuid)
      .catch(() => uuid);
  }

  static _set(uuid: string, name: string) {
    this.cache.set(uuid, name);
  }

  static async get(uuid: string) {
    if (this.cache.has(uuid)) return this.cache.get(uuid);

    const name = await this._computeName(uuid);
    this.cache.set(uuid, name);
    return name;
  }
}
