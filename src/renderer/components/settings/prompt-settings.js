export function createPromptSettings(dialog, api, setPageBusy) {
  const panel = dialog.querySelector("#settings-prompt-panel");
  const core = panel.querySelector("#prompt-core");
  const editor = panel.querySelector("#prompt-default");
  const current = panel.querySelector("#prompt-current");
  const info = panel.querySelector("[data-prompt-current-info]");
  const status = panel.querySelector("#prompt-status");
  const saveButton = panel.querySelector("[data-prompt-save]");
  const reloadButton = panel.querySelector("[data-prompt-reload]");
  let busy = true, loading = false, saving = false, loaded = false;
  let revision = null, savedText = "", sequence = 0;

  function update() {
    const blocked = busy || loading || saving;
    editor.disabled = blocked || !loaded;
    reloadButton.disabled = blocked;
    saveButton.disabled = blocked || !loaded || editor.value === savedText;
    panel.setAttribute("aria-busy", String(loading || saving));
  }

  async function refreshCurrent(token) {
    current.value = "";
    info.textContent = "正在读取当前对话提示词……";
    try {
      const snapshot = await api.getSessionPromptInfo();
      // 关闭后重新打开时，旧请求不能覆盖新面板状态。
      if (token !== sequence || !dialog.open) return;
      if (!snapshot) {
        info.textContent = "当前对话没有可读取的提示词快照。";
        return;
      }
      current.value = snapshot.testAgentPrompt;
      info.textContent = `当前对话使用修订 ${snapshot.revision}。` +
        (snapshot.origin === "legacy" ? "这是旧对话首次采用的配置，原提示词版本未知。" : "");
    } catch (error) {
      if (token === sequence && dialog.open) {
        info.textContent = `当前对话暂不可读：${error.message}；仍可编辑新对话默认值。`;
      }
    }
  }

  async function load() {
    if (busy || loading || saving) return;
    const token = ++sequence;
    loading = true;
    update();
    status.textContent = "正在读取提示词配置……";
    try {
      const settings = await api.readPromptSettings();
      if (token !== sequence || !dialog.open) return;
      core.value = settings.basePrompt;
      editor.value = settings.testAgentPrompt;
      savedText = settings.testAgentPrompt;
      revision = settings.revision;
      loaded = true;
      status.textContent = `已读取默认修订 ${revision}。编辑后需要点击保存。`;
      await refreshCurrent(token);
    } catch (error) {
      if (token === sequence && dialog.open) {
        status.textContent = `读取失败：${error.message}；已有编辑内容保留。`;
      }
    } finally {
      if (token === sequence) {
        loading = false;
        update();
      }
    }
  }

  editor.addEventListener("input", update);
  reloadButton.addEventListener("click", () => { void load(); });
  saveButton.addEventListener("click", async () => {
    if (saveButton.disabled) return;
    saving = true;
    // 共用全页面忙碌状态，保存期间不能发送、切换或关闭设置。
    setPageBusy(true);
    update();
    status.textContent = "正在保存提示词……";
    try {
      const settings = await api.savePromptSettings({ testAgentPrompt: editor.value }, revision);
      revision = settings.revision;
      savedText = settings.testAgentPrompt;
      status.textContent = `已保存默认修订 ${revision}；从下一个新对话起使用。`;
    } catch (error) {
      // 冲突或写入失败时保留用户编辑，不自动用远端内容覆盖。
      status.textContent = `保存未确认：${error.message}。可先复制编辑内容，再重新读取核对。`;
    } finally {
      saving = false;
      setPageBusy(false);
      update();
    }
  });

  dialog.addEventListener("close", () => {
    sequence += 1;
    loading = false;
    update();
  });

  update();
  return {
    setBusy(value) { busy = value; update(); },
    isSaving: () => saving,
    show() {
      if (busy || loading || saving) return;
      if (!loaded) { void load(); return; }
      // 保留尚未保存的默认值编辑，仅刷新当前对话的只读快照。
      void refreshCurrent(++sequence);
    },
  };
}
