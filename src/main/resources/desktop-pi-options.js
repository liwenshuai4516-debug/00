function createDesktopPiOptions(dialog, shutdown) {
  return {
    shutdown,
    async askProjectTrust(projectDir) {
      const result = await dialog.showMessageBox({
        type: "question",
        title: "项目资源信任",
        message: "是否信任此目录的项目设置与资源？",
        detail: `${projectDir}\n\n信任后 Pi 可加载项目设置、技能、扩展和包；扩展及包安装过程可能执行代码。原生工具可直接读写文件和执行命令，工作目录不是访问隔离边界。`,
        buttons: ["不信任", "信任"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        checkboxLabel: "记住此目录及子目录的选择",
        checkboxChecked: false,
      });
      return { trusted: result.response === 1, remember: result.checkboxChecked };
    },
    async onDiagnostics(diagnostics) {
      await dialog.showMessageBox({
        type: "warning",
        title: "Pi 资源提示",
        message: "部分资源加载失败或存在提示。",
        detail: diagnostics.map((item) => `[${item.type}] ${item.path ?? ""}\n${item.message}`).join("\n\n"),
        buttons: ["继续"],
        noLink: true,
      });
    },
  };
}

module.exports = { createDesktopPiOptions };
