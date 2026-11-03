const fs = require("node:fs");
const path = require("node:path");
const personalSkills = path.join(require("node:os").homedir(), ".agents", "skills");
const exists = fs.existsSync;

// 默认 loader 仍会探测个人技能；测试只允许临时夹具，不读取真实个人资源。
fs.existsSync = (file) => {
  const target = path.resolve(String(file));
  return target === personalSkills || target.startsWith(`${personalSkills}${path.sep}`)
    ? false
    : exists(file);
};
require("node:module").syncBuiltinESMExports();
