import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

// 工具只负责参数定义和执行，不依赖 Electron 或页面。
export const currentTimeTool = defineTool({
  name: "get_current_time",
  label: "获取当前时间",
  description: "获取当前北京时间，回答用户询问当前日期或时间的问题。",
  parameters: Type.Object({}),

  async execute() {
    const time = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      dateStyle: "full",
      timeStyle: "long",
    }).format(new Date());

    console.log("工具调用：get_current_time");

    // content 提供给模型，details 保留结构化执行结果。
    return {
      content: [{ type: "text", text: time }],
      details: {},
    };
  },
});