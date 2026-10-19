/* 跨模块共享的可变 UI 状态（v0.11.0 收敛）：多模块直接赋值的顶层变量
   无法用 ESM 导入绑定承载（导入只读），统一挂到可变对象 U 上。 */
export const U = {
  lastStockAgg: new Map(),
  tradeMode: (() => { try { return localStorage.getItem('sj_tradeMode') || 'list'; } catch (e) { return 'list'; } })(),
  holdSort: { key: null, dir: 0 },
};
