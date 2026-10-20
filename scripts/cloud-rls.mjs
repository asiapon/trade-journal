/* 生成云库 RLS 配置的 SQL 清单（供逐条 exec_sql 执行）
   用法：node scripts/cloud-rls.mjs
   输出：每张表所需的 migrate 语句数组，供调用方按序执行。 */
const TABLES = ['trades', 'watchlist', 'quotes', 'settings', 'op_logs', 'qa_history'];

const stmts = [];
for (const t of TABLES) {
  stmts.push(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
  stmts.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${t} TO authenticated, anon`);
  stmts.push(`CREATE POLICY ${t}_select_own ON ${t} FOR SELECT TO authenticated USING (owner_id = auth.uid())`);
  stmts.push(`CREATE POLICY ${t}_insert_own ON ${t} FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid())`);
  stmts.push(`CREATE POLICY ${t}_update_own ON ${t} FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid())`);
  stmts.push(`CREATE POLICY ${t}_delete_own ON ${t} FOR DELETE TO authenticated USING (owner_id = auth.uid())`);
}
console.log(JSON.stringify(stmts, null, 2));
