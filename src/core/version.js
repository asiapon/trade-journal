/* 应用版本号（v3.18.4 自 app.js 迁出）：stockdict.js 等底层模块也要用，
   旧写法放 app.js 模块作用域里，底层模块拿不到 → ReferenceError →
   股票字典种子载入静默失败，全应用名称/拼音搜索失效（v0.11.0 拆分遗留）。 */
export const APP_VER = '3.18.4';
