# -*- coding: utf-8 -*-
"""v0.11.0 M3 收尾拆解驱动：把 src/app.js 剩余单体按域切成正式 ESM 模块。

流程：解析顶层声明 → 按域切块 → 跨模块直接赋值的 let/var 收敛进 core/ui-state.js(U)
→ 引用改写 U.X → 各模块生成（公共头 + 自动依赖导入 + 全量 export）→ 重写 app.js。
"""
import io, re, os, sys

SRC = 'src/app.js'
COMMON = """import { $, toast, fmt2, fmtP, fmtPct, pnlCls, esc, fmtTime, nowLocalInput, inferMarket, MKT_NAME } from '__P__shared/utils.js';
import { NetLog, sjTokenHeaders } from '__P__core/netlog.js';
import { StockDict } from '__P__core/stockdict.js';
import { DL } from '__P__core/data-layer.js';
import { emQuote, txQuote } from '__P__sources/quotes.js';
import { TABLES, BACKEND_URL, RPC_BASE, ACCESS_KEY, CLOUD_HOST, rpc, cloudStore, localStore, setStore, loadAll, saveSetting, sessionHooks, storageHooks } from '__P__storage/gateway.js';
import { S } from '__P__core/app-state.js';"""

PART = {
 'src/ui/widgets.js': ['SUG_OFF_IN_WATCH_PC','bindSuggest','confirmCb','confirmInputCb','confirmDlg','promptDlg','closeConfirm'],
 'src/features/quotes.js': ['NetQuote','ModelMgr','refreshQuotes'],
 'src/features/llm.js': ['customLlmStream','llmComplete','nowStr'],
 'src/features/journal.js': ['DEFAULT_FEES','feeCfg','FUND_FEES','isFundCode','r2','calcFees','isInitTrade','buildTradeRow','computeHoldings','quoteMap','tradeParseSys','extractJson','cleanNum','normalizeParsed','reconcileParsedCode','toLocalInput','resToList','parseTradeText','pendingTrades','aiParseEntry','renderPending','renderTrades','tradeRowFiltered','TRADE_HEAD_LIST','TRADE_HEAD_STOCK','feeDetailRow','fillTradeForm','unlockTradeForm','resetTradeForm','scrollRecBottom','setNlOpen','setManualOpen','openRecModal','closeRecModal','syncTfTypeTabs','setTfStock','resolveTfStock','updateFeePreview','autoWatchOnBuy','tradeMode','fillFormFromParsed'],
 'src/features/overview.js': ['todayRealizedPnl','renderToday','WB_COLORS','HOLD_MOUNTS','WATCH_MOUNTS','renderHoldings','stockDetailRow','feeOpenIds','stockOpenCodes','lastStockAgg'],
 'src/features/watchlist.js': ['watchTab','watchGroups','saveWatchGroups','addWatchGroup','removeWatchGroup','allWatchGroups','watchSort','holdSort','updateSortHead','updateWatchHead','watchModel','paintWatch','renderWatch','syncGroupList','openWatchModal','watchFocusTarget','closeWatchModal','fitWatchModal','setWatchFormOpen','fillWatchForm','resetWatchForm','bindWatchCard','delWatchGroup'],
 'src/features/me.js': ['renderFeeEditor','saveFeeEditor','switchSetPane','renderMe','netLogLine','renderNetLogUI','renderLogs','loadUsers'],
 'src/ui/bind.js': ['bindEvents','switchView','syncQuoteFab','QF_POS_KEY','setQuoteFabTop','saveQuoteFabPos','initQuoteFabDrag'],
 'src/features/diagnose.js': ['secidOf','fetchKlineEast','KL_URLS','fetchKlineTxRaw','fetchKlineTx','fetchKline','calcMA','calcEMA','calcMACD','calcRSI','calcKDJ','calcBOLL','calcATR','findLevels','analyzeTimeframe','combineTechSignal','fmtVol','KC_UP','KC_DOWN','drawCandleChart','bindKchartHover','redrawAnalysisCanvases','_techResizeTimer','bindTechResize','diagPickCode','renderAnalysisSelect','bindStockPick','diagnoseStock','renderDiagView','syncDiagAiBtn','closeDiag','reopenDiag','dropDiag','diagHtml','runDiagAi','DIAG_HIST_KEY','loadDiagHistory','saveDiagHistoryItem','renderDiagHistory','saveDiagReport'],
 'src/features/qa.js': ['QA_HISTORY_LIMIT','QA_CTX_TRADES','QA_EXAMPLES','qaState','qaNewId','qaMsgsOf','qaAttach','qaMdInline','qaMdToHtml','qaLlmStream','qaAgentTools','qaAgentSkillFn','qaAgentExec','qaLlmChat','qaAgentLoop','qaHoldingsSummary','qaBuildContext','qaSysPrompt','qaPickStock','qaEmptyHtml','qaUseExample','bindQaExamples','renderQaSkillPick','qaUserMsgParts','qaUserMsgText','qaUserMsgHtml','qaJumpCollapsed','renderQaJump','bindQaJump','qaRenderDrawerBadge','renderQaChips','qaAddFile','qaLocalSet','sendQa','qaStop','qaReloadAll','qaLoadConversation','qaDeleteConversation','initQa','renderQaMessages','renderQaHistory','qaSyncSendState','qaBoot'],
 'src/features/voice.js': ['sjCreateMic','sjAsrCfgGet','sjAsrCfgSet','sjBlobToWav16k','sjBlobB64','sjAsrTranscribe'],
}
APP_KEEP = {'cloudLlm','initCloudLlm','APP_VER','ICO','renderAll','ensureCloudLlm'}
DOC = {
 'src/ui/widgets.js': 'UI 微件：输入联想 + 确认/输入弹窗',
 'src/features/quotes.js': '行情轮询引擎（NetQuote，含 DataLayer 收口）+ 模型管理器',
 'src/features/llm.js': 'LLM 网关：自定义模型流式 + 免密云端补全',
 'src/features/journal.js': '记账域：费用引擎 / 记录渲染 / 记账表单 / 自然语言解析',
 'src/features/overview.js': '总览域：今日统计 / 持仓渲染（移动加权平均）',
 'src/features/watchlist.js': '自选域：分组 / 排序 / 卡片与弹窗',
 'src/features/me.js': '设置页域：费率编辑 / 卡片渲染 / 日志视图 / 用户管理数据',
 'src/ui/bind.js': '视图绑定：全站事件委托 bindEvents / 视图切换 switchView / 行情悬浮球',
 'src/features/diagnose.js': '技术分析域：K线多源拉取 / 指标计算 / 画图 / 诊断报告',
 'src/features/qa.js': '问答域：会话 / Agent 工具循环 / 上下文注入 / 历史管理',
 'src/features/voice.js': '语音域：双引擎（Web Speech / MediaRecorder→ASR）',
}

decl_re = re.compile(r'^(export\s+)?(async\s+)?(function|const|let|var)\s+([A-Za-z_$][\w$]*)')

def main():
    src = io.open(SRC, encoding='utf-8').read()
    lines = src.split('\n')
    n = len(lines)

    decls = []
    for i, ln in enumerate(lines):
        m = decl_re.match(ln)
        if m:
            decls.append({'name': m.group(4), 'kind': m.group(3), 'start': i, 'export': bool(m.group(1))})
    for k, d in enumerate(decls):
        d['end'] = decls[k+1]['start'] if k+1 < len(decls) else n
    # 多声明符（const A = x, B = y）只针对 const/let/var 行
    extra = []
    for d in decls:
        if d['kind'] not in ('const', 'let', 'var'):
            continue
        for m2 in re.finditer(r',\s*([A-Za-z_$][\w$]*)\s*=', lines[d['start']]):
            nm2 = m2.group(1)
            if all(x['name'] != nm2 for x in decls + extra):
                nd = dict(d); nd['name'] = nm2
                extra.append(nd)
    decls += extra
    by_name = {}
    for d in decls:
        if d['name'] in by_name:
            print('!! 重复顶层声明:', d['name']); sys.exit(1)
        by_name[d['name']] = d

    owner = {}
    for f, names in PART.items():
        for nm in names:
            if nm not in by_name:
                print('!! 分配表符号不存在:', nm); sys.exit(1)
            owner[nm] = f
    for nm in APP_KEEP:
        owner[nm] = 'app'
    for d in decls:
        if d['name'] not in owner:
            owner[d['name']] = 'app'
            print('   [留在 app.js]', d['kind'], d['name'])

    # ---- 切块 ----
    moved = {f: [] for f in PART}          # file -> [lines]
    covered = set()
    tail_pat = re.compile(r'^(boot\(\);|globalThis\.)')
    for d in decls:
        nm = d['name']
        f = owner[nm]
        if f != 'app':
            for i in range(d['start'], d['end']):
                if tail_pat.match(lines[i]):
                    continue          # 尾部散语句（boot 调用 / globalThis 桥）留在 app.js
                moved[f].append(lines[i])
                covered.add(i)
    kept = [ln for i, ln in enumerate(lines) if i not in covered]

    # ---- 跨模块直接赋值检测（基于切分后文本） ----
    def assign_pat(nm):
        return re.compile(r'(?<![\w$.])' + re.escape(nm) + r'\s*(=(?!=)|\+=|-=|\*=|/=|\+\+|--)')
    scan = {'app': '\n'.join(kept)}
    for f, body in moved.items():
        scan[f] = '\n'.join(body)
    for f in ['src/storage/gateway.js', 'src/features/auth.js', 'src/main.js']:
        scan[f] = io.open(f, encoding='utf-8').read()
    shared_mut = {}
    for nm, d in by_name.items():
        home = owner.get(nm)
        if home == 'app' or d['kind'] not in ('let', 'var'):
            continue
        for f, txt in scan.items():
            if f == home:
                continue
            if assign_pat(nm).search(txt):
                shared_mut[nm] = home
                print('   [U 收敛]', nm, '(home %s ← 赋值于 %s)' % (home, f))
                break

    # ---- U 初始化提取 ----
    u_inits = []
    for nm in shared_mut:
        d = by_name[nm]
        txt = '\n'.join(lines[d['start']:d['end']])
        eq = txt.index('=', txt.index(nm))
        depth = 0; end = None; i = eq + 1; instr = None
        while i < len(txt):
            c = txt[i]
            if instr:
                if c == '\\': i += 2; continue
                if c == instr: instr = None
            elif c in ('"', "'", '`'): instr = c
            elif c in '({[': depth += 1
            elif c in ')}]': depth -= 1
            elif c == ';' and depth == 0:
                end = i; break
            i += 1
        u_inits.append((nm, txt[eq+1:end].strip()))
    if u_inits:
        io.open('src/core/ui-state.js', 'w', encoding='utf-8', newline='\n').write(
            "/* 跨模块共享的可变 UI 状态（v0.11.0 收敛）：多模块直接赋值的顶层变量\n"
            "   无法用 ESM 导入绑定承载（导入只读），统一挂到可变对象 U 上。 */\n"
            "export const U = {\n" +
            ''.join('  %s: %s,\n' % (nm, init) for nm, init in u_inits) +
            "};\n")

    def rewrite_u(t):
        for nm in shared_mut:
            t = re.sub(r'(?<![\w$.])' + re.escape(nm) + r'\b', 'U.' + nm, t)
        return t

    scan = {f: rewrite_u(t) for f, t in scan.items()}
    ident_re = re.compile(r'[A-Za-z_$][\w$]*')

    # ---- 生成模块文件 ----
    for f, body in moved.items():
        text = '\n'.join(body)
        if not text.strip():
            continue
        text = rewrite_u(text)
        refs = set(ident_re.findall(text))
        need = {}
        for nm, of in owner.items():
            if of == f or nm not in refs:
                continue
            need.setdefault(of, []).append(nm)
        pfx = '../'
        imp = [COMMON.replace('__P__', pfx)]
        if re.search(r'(?<![\w$.])U\.', text):
            imp.append("import { U } from '__P2__core/ui-state.js';".replace('__P2__', pfx))
        for of in sorted(need):
            if of == 'app':
                imp.append("import { %s } from '__P2__app.js';".replace('__P2__', pfx) % (', '.join(sorted(set(need[of])))))
            elif of.startswith('src/features/') and f.startswith('src/features/'):
                imp.append("import { %s } from './%s';" % (', '.join(sorted(set(need[of]))), os.path.basename(of)))
            elif of.startswith('src/ui/') and f.startswith('src/ui/'):
                imp.append("import { %s } from './%s';" % (', '.join(sorted(set(need[of]))), os.path.basename(of)))
            elif of.startswith('src/ui/') or of.startswith('src/features/'):
                d2 = 'features' if of.startswith('src/features/') else 'ui'
                imp.append("import { %s } from '../%s/%s';" % (', '.join(sorted(set(need[of]))), d2, os.path.basename(of)))
        out = []
        for ln in body:
            m = decl_re.match(ln)
            if m and not m.group(1):
                ln = 'export ' + ln
            out.append(ln)
        os.makedirs(os.path.dirname(f), exist_ok=True)
        io.open(f, 'w', encoding='utf-8', newline='\n').write(
            '/* %s（v0.11.0 自单体拆出） */\n' % DOC.get(f, '') + '\n'.join(imp) + '\n\n' + '\n'.join(out))

    # ---- 重写 app.js ----
    app_text = scan['app']
    refs = set(ident_re.findall(app_text))
    need_mod = {}
    for nm, of in owner.items():
        if of != 'app' and nm in refs:
            need_mod.setdefault(of, []).append(nm)
    add = []
    if re.search(r'(?<![\w$.])U\.', app_text):
        add.append("import { U } from './core/ui-state.js';")
    for of in sorted(need_mod):
        add.append("import { %s } from '%s';" % (', '.join(sorted(set(need_mod[of]))), of.replace('src/', './')))
    lines2 = app_text.split('\n')
    last_imp = max(i for i, l in enumerate(lines2) if l.startswith('import '))
    reexp = ["export { ModelMgr, refreshQuotes } from './features/quotes.js';",
             "export { initQa, renderQaMessages, renderQaHistory, qaSyncSendState, qaBoot } from './features/qa.js';",
             "export { bindEvents, switchView } from './ui/bind.js';",
             "export { renderNetLogUI, renderMe, switchSetPane, loadUsers, renderLogs } from './features/me.js';",
             "export { fetchKlineEast, fetchKlineTx } from './features/diagnose.js';"]
    lines2[last_imp+1:last_imp+1] = reexp + add
    app_final = '\n'.join(lines2)
    for old, new in [('   [ ] features/journal：查询页/记账表单/费率', '   [x] features/journal（v0.11.0）'),
                     ('   [ ] features/overview：总览/持仓/行情联动', '   [x] features/overview（v0.11.0）'),
                     ('   [ ] features/qa：问答引擎/模型管理/技能中心', '   [x] features/qa（v0.11.0）'),
                     ('   [ ] features/voice：语音双引擎', '   [x] features/voice（v0.11.0）'),
                     ('   [ ] ui/bind：bindEvents/switchView/弹窗', '   [x] ui/bind（v0.11.0）')]:
        app_final = app_final.replace(old, new)
    io.open(SRC, 'w', encoding='utf-8', newline='\n').write(app_final)
    print('== 完成 ==  app.js', app_final.count('\n'), 'lines')
    for f in PART:
        if os.path.exists(f):
            print('  ', f, io.open(f, encoding='utf-8').read().count('\n'), 'lines')

main()
