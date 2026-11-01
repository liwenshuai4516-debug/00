const { test } = require("node:test");
const path = require("node:path");
const os = require("node:os");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const {
  mkdtemp,
  mkdir,
  symlink,
  writeFile,
  rm,
} = require("node:fs/promises");

const runFile = promisify(execFile);

test("显式目录用于真实 Pi 会话及文件工具，无效目录不回退", async (t) => {
  const base = await mkdtemp(
    path.join(os.tmpdir(), "agent-pi-workspace-"),
  );

  t.after(() => rm(base, { recursive: true, force: true }));

  const defaultDir = path.join(base, "default");
  const selectedDir = path.join(base, "selected");
  const alias = path.join(base, "alias");

  await mkdir(defaultDir);
  await mkdir(selectedDir);
  await symlink(selectedDir, alias);

  // 两个目录放同名文件，用内容判断工具实际读取了哪个目录。
  await writeFile(path.join(defaultDir, "marker.txt"), "默认目录");
  await writeFile(path.join(selectedDir, "marker.txt"), "所选目录");

  const agentUrl = pathToFileURL(
    require.resolve("../../src/main/pi-agent.mjs"),
  ).href;

  const script = `
    const assert = require("node:assert/strict");
    const { realpathSync } = require("node:fs");

    globalThis.fetch = async () => assert.fail("测试不能访问网络");

    async function check() {
      const { createPiAgent } = await import(${JSON.stringify(agentUrl)});
      const [sessionDir, selectedDir, alias] = process.argv.slice(1);
      const originalDefault = process.env.AGENT_WORKSPACE_DIR;

      const session = await createPiAgent(
        sessionDir,
        false,
        undefined,
        alias,
      );

      try {
        const expected = realpathSync(selectedDir);
        assert.equal(session.sessionManager.getCwd(), expected);

        const binding = session.sessionManager.getEntries().find(
          entry => entry.customType === "desktop-workspace-binding"
        );
        assert.equal(binding.data.workspaceRoot, expected);

        // 直接执行真实读取工具，不调用 prompt 或请求模型。
        const reader = session.agent.state.tools.find(
          tool => tool.name === "read_workspace_text_file"
        );
        const result = await reader.execute("test-read", {
          path: "marker.txt",
        });

        assert.equal(result.details.text, "所选目录");
        assert.equal(
          process.env.AGENT_WORKSPACE_DIR,
          originalDefault,
        );
      } finally {
        session.dispose();
      }

      // 显式参数无效时必须拒绝，不能退回有效的默认目录。
      for (const invalidDir of ["", "relative/path"]) {
        await assert.rejects(
          createPiAgent(sessionDir, false, undefined, invalidDir),
          /配置为绝对路径/,
        );
      }
    }

    check().catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
  `;

  await runFile(
    process.execPath,
    ["-e", script, path.join(base, "sessions"), selectedDir, alias],
    {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: path.join(base, "pi-config"),
        PI_OFFLINE: "1",
        PI_PROVIDER: "deepseek",
        PI_MODEL: "deepseek-flash",
        PI_BASE_URL: "https://example.invalid/v1",
        DEEPSEEK_API_KEY: "test-only-not-a-real-key",
        AGENT_WORKSPACE_DIR: defaultDir,
      },
      encoding: "utf8",
    },
  );
});