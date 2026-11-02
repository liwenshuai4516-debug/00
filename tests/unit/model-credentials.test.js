const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtemp, rm, readFile, writeFile, stat } = require("node:fs/promises");
const { createCipheriv, createDecipheriv, randomBytes } = require("node:crypto");
const { createModelCredentialsStore } = require("../../src/main/storage/model-credentials-store.js");

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "model-credentials-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const secret = randomBytes(32);
  const protection = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", secret, iv);
      const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString(value) {
      const decipher = createDecipheriv("aes-256-gcm", secret, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString();
    },
  };
  const file = path.join(dir, "credentials.json");
  return { file, protection, store: createModelCredentialsStore(file, protection) };
}

test("命名密钥加密保存、串行新增、切换及删除当前密钥", async t => {
  const { file, store, protection } = await setup(t);
  const [a, b] = await Promise.all([store.addKey("provider", "A", "secret-A"), store.addKey("provider", "B", "secret-B")]);
  assert.equal((await store.state("provider")).credential.key, "secret-A");
  await store.activateKey("provider", b.id);
  assert.equal((await store.state("provider")).credential.key, "secret-B");
  assert.equal(JSON.stringify(await store.listKeys("provider")).includes("secret"), false);
  const saved = await readFile(file, "utf8");
  assert.equal(saved.includes("secret-A"), false); assert.equal(saved.includes("secret-B"), false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const reopened = createModelCredentialsStore(file, protection);
  assert.equal((await reopened.state("provider")).credential.key, "secret-B");
  await reopened.removeKey("provider", b.id);
  assert.deepEqual(await reopened.state("provider"), { overridden: true, credential: undefined });
  assert.equal((await reopened.listKeys("provider")).keys[0].id, a.id);
});

test("OAuth 令牌并发刷新按当前记录串行，退出后保留命名密钥但不自动激活", async t => {
  const { store, file } = await setup(t);
  await store.addKey("provider", "A", "saved-key");
  await store.modify("provider", async () => ({ type: "oauth", access: "token-0", refresh: "refresh", expires: 1, revision: 0 }));
  await Promise.all([1, 2].map(() => store.modify("provider", async current => ({ ...current, revision: current.revision + 1 }))));
  assert.equal((await store.state("provider")).credential.revision, 2);
  assert.equal((await readFile(file, "utf8")).includes("token-0"), false);
  await store.logout("provider");
  assert.equal((await store.state("provider")).credential, undefined);
  assert.equal((await store.listKeys("provider")).keys.length, 1);
});

test("非法或重复密钥、加密不可用、取消刷新和损坏文件保留原记录", async t => {
  const { store, file, protection } = await setup(t);
  await store.addKey("provider", "A", "saved-key");
  const before = await readFile(file, "utf8");
  await assert.rejects(store.addKey("provider", "A", "other"), /已存在/);
  await assert.rejects(store.addKey("provider", "B", "bad\nkey"), /有效/);
  protection.isEncryptionAvailable = () => false;
  await assert.rejects(store.addKey("provider", "B", "other"), /不可用/);
  protection.isEncryptionAvailable = () => true;
  const controller = new AbortController();
  await assert.rejects(store.modify("provider", async () => {
    controller.abort(); return { type: "oauth", access: "cancelled" };
  }, { signal: controller.signal }));
  assert.equal(await readFile(file, "utf8"), before);
  await writeFile(file, "{bad");
  await assert.rejects(store.listKeys("provider"), /损坏/);
  assert.equal(await readFile(file, "utf8"), "{bad");
});
