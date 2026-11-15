/**
 * build-af.js — 把圣遗物筛选系统的引擎与配置内嵌进 genshin-roster/index.html
 *
 * 单一数据源：引擎 = ../artifact-judge.js，配置 = ../流派配置.json。
 * index.html 里有一对标记  //__AF_INJECT_START__  //__AF_INJECT_END__ ，
 * 本脚本把两者改造后注入标记之间（配置原样；引擎去掉文件读取和 CLI 演示，
 * CFG 指向注入的 window.AF_CFG，包一层 IIFE 避免与应用的全局常量撞名）。
 *
 * 用法：node build-af.js
 * 什么时候要重跑：改了 artifact-judge.js 或 流派配置.json 之后。
 */
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const htmlPath = path.join(dir, "index.html");
let html = fs.readFileSync(htmlPath, "utf8");

const parentDir = path.join(dir, "..");
const dataDir = fs.existsSync(path.join(dir, "流派配置.json")) ? dir : parentDir;
const cfgRaw = fs.readFileSync(path.join(dataDir, "流派配置.json"), "utf8").trim();
let engine = fs.readFileSync(path.join(dataDir, "artifact-judge.js"), "utf8");

/* 引擎改造：剥掉头注释（内有 require 用法说明会误报警卫）、去 fs/path、
   CFG 换成注入对象、砍掉 CLI 演示段 */
engine = engine.replace(/^\/\*\*[\s\S]*?\*\//, "");
engine = engine.replace(/const fs = require\('fs'\);\r?\n/, "");
engine = engine.replace(/const path = require\('path'\);\r?\n/, "");
engine = engine.replace(
  /const CFG = JSON\.parse\(fs\.readFileSync\(path\.join\(__dirname, '流派配置\.json'\), 'utf8'\)\);/,
  "const CFG = window.AF_CFG;"
);
const cutM = engine.match(/\/\/ ---------------- 内置(演示|测试)件 ----------------/);
if (cutM) engine = engine.slice(0, cutM.index);
if (/(^|[^.\w])require\s*[.(]|module\.exports|__dirname/.test(engine)) {
  console.error("引擎里仍有 Node 专用代码未清理，中止");
  process.exit(1);
}

const START = "//__AF_INJECT_START__";
const END = "//__AF_INJECT_END__";
if (!html.includes(START) || !html.includes(END)) {
  console.error("index.html 里未找到注入标记，中止");
  process.exit(1);
}
const injected =
  START + "\n" +
  "/* 本段由 build-af.js 自动生成：数据源 ../流派配置.json + ../artifact-judge.js，改后请重跑 node build-af.js */\n" +
  "window.AF_CFG = " + cfgRaw + ";\n" +
  "(function () {\n" + engine + "\nwindow.AF = { judge, bestFit, scoreDetail, setBonus, scoreArtifact, rollEq, getChar, specialOf, charEff, expectedGain, validateArt, scaleFactor, CFG };\n})();\n" +
  END;

html = html.slice(0, html.indexOf(START)) + injected + html.slice(html.indexOf(END) + END.length);
fs.writeFileSync(htmlPath, html);
console.log("已注入：配置 %d 字节 + 引擎 %d 字节 → index.html", cfgRaw.length, engine.length);
