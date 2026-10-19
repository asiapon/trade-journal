/* 应用全局状态（自 legacy 拆出） */
export const S = {
  mode: null,            // 'cloud' | 'local'
  token: null,
  user: null,            // {username, role, local?}
  trades: [], watchlist: [], quotes: [], settings: {}, opLogs: [],
  editingTradeId: null,
  editingWatchId: null,
  editingPriceCode: null,
};

