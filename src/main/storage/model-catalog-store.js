const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { readFile, mkdir, writeFile, rename, rm } = require("node:fs/promises");

// SDK 的官方目录缓存独立于个人 models.json；设置页只恢复本应用下载的目录。
function createModelCatalogStore(directory) {
  function fileFor(provider) {
    if (typeof provider !== "string" || !provider || provider.length > 200) throw new Error("供应商编号无效。");
    return path.join(directory, `${encodeURIComponent(provider)}.json`);
  }
  async function read(provider, options = {}) {
    options.signal?.throwIfAborted();
    let content;
    try { content = await readFile(fileFor(provider), "utf8"); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    let entry;
    try {
      entry = JSON.parse(content);
      if (!Array.isArray(entry.models) || entry.models.some(model => typeof model.id !== "string" || model.provider !== provider)) throw new Error();
    } catch { throw new Error("官方模型目录缓存损坏，请刷新目录。"); }
    return entry;
  }
  async function write(provider, entry, options = {}) {
    options.signal?.throwIfAborted();
    const file = fileFor(provider), temporary = `${file}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporary, JSON.stringify(entry) + "\n", { mode: 0o600, flag: "wx" });
      options.signal?.throwIfAborted();
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  return { read, write, async delete(provider, options = {}) { options.signal?.throwIfAborted(); await rm(fileFor(provider), { force: true }); } };
}

module.exports = { createModelCatalogStore };
