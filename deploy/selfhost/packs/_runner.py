# SKILL.md 技能包执行器（由 skillpack.js 自动维护）
# 用法：python _runner.py <pack名> <函数名> <args JSON> <结果输出文件>
# 结果写文件而非 stdout —— mootdx 等库的进度条会异步污染 stdout，任何标记法都不可靠。
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib
mod = importlib.import_module(sys.argv[1])
fn = getattr(mod, sys.argv[2], None)
assert fn, '函数不存在: ' + sys.argv[2]
args = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
result = fn(**args)
out_path = sys.argv[4] if len(sys.argv) > 4 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "_result.json")
with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(result, f, ensure_ascii=False, default=str)