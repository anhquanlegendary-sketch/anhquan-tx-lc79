#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import os
import sys
import json
import time
import uuid
import logging
import threading
from datetime import datetime

# Tắt log
logging.disable(logging.CRITICAL)

class NullWriter:
    def write(self, *a, **k): pass
    def flush(self, *a, **k): pass

if os.environ.get("SILENT_MODE", "1") == "1":
    sys.stdout = NullWriter()
    sys.stderr = NullWriter()

# Load zlapi
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if os.path.isdir(os.path.join(BASE_DIR, "zlapi")):
    sys.path.insert(0, BASE_DIR)

ZLAPI_AVAILABLE = False
try:
    from zlapi import ZaloAPI, ThreadType, Message, MessageStyle, MultiMsgStyle
    from zlapi.models import *
    ZLAPI_AVAILABLE = True
except Exception as e:
    # Ghi lỗi ra file để debug
    with open("/tmp/zlapi_error.txt", "w") as f:
        f.write(str(e))

from flask import Flask, render_template_string, request, jsonify

app = Flask(__name__)
app.secret_key = os.urandom(24).hex()

TASKS = {}
SESSIONS = {}
CLIENTS = {}
LOCK = threading.Lock()
CLIENT_TIMEOUT = 15


class Bot(ZaloAPI):
    def __init__(self, imei, session_cookies, task_id=None):
        super().__init__("dummy_api_key", "dummy_secret_key", imei, session_cookies)
        self.task_id = task_id
        self.running = False
        self.spam_count = 0

    def fetchAllGroupIds(self):
        try:
            all_groups = super().fetchAllGroups()
            group_ids = []
            if hasattr(all_groups, 'gridVerMap'):
                for gid in all_groups.gridVerMap.keys():
                    group_ids.append(gid)
            elif hasattr(all_groups, 'groups'):
                for g in all_groups.groups:
                    if hasattr(g, 'id'):
                        group_ids.append(g.id)
            elif hasattr(all_groups, 'data') and isinstance(all_groups.data, dict):
                for gid in all_groups.data.keys():
                    group_ids.append(gid)
            elif isinstance(all_groups, dict):
                for gid in all_groups.keys():
                    group_ids.append(gid)
            return group_ids
        except Exception:
            return []

    def get_group_name(self, thread_id):
        try:
            info = super().fetchGroupInfo(thread_id)
            if hasattr(info, 'gridInfoMap') and thread_id in info.gridInfoMap:
                return info.gridInfoMap[thread_id].get("name", "Nhóm " + thread_id[:8])
            return "Nhóm " + thread_id[:8]
        except Exception:
            return "Nhóm " + thread_id[:8]

    def send_styled_message(self, thread_id, text, font_size=18):
        try:
            n = len(text)
            styles = [
                MessageStyle(offset=0, length=n, style="color", color="#DB342E", auto_format=False),
                MessageStyle(offset=0, length=n, style="bold", auto_format=False),
            ]
            try:
                styles.append(MessageStyle(offset=0, length=n, style="font", size=str(font_size), auto_format=False))
            except Exception:
                pass
            msg = Message(text=text, style=MultiMsgStyle(styles))
            self.sendMessage(msg, thread_id=thread_id, thread_type=ThreadType.GROUP)
            self.spam_count += 1
        except Exception:
            try:
                self.sendMessage(Message(text=text), thread_id=thread_id, thread_type=ThreadType.GROUP)
                self.spam_count += 1
            except Exception:
                pass

    def spam_forever(self, thread_ids, content, delay, font_size=18):
        try:
            self.running = True
            for tid in thread_ids:
                if not self.running: break
                try:
                    self.setTyping(tid, ThreadType.GROUP)
                    time.sleep(0.3)
                    self.send_styled_message(tid, content, font_size)
                except Exception:
                    pass
            while self.running:
                elapsed = 0.0
                while elapsed < delay and self.running:
                    time.sleep(min(0.5, delay - elapsed))
                    elapsed += 0.5
                if not self.running: break
                for tid in thread_ids:
                    if not self.running: break
                    try:
                        self.setTyping(tid, ThreadType.GROUP)
                        time.sleep(0.3)
                        self.send_styled_message(tid, content, font_size)
                    except Exception:
                        pass
        except Exception:
            pass

    def stop(self):
        self.running = False


def cleanup_worker():
    while True:
        try:
            time.sleep(5)
            now = time.time()
            with LOCK:
                dead = [c for c, t in list(CLIENTS.items()) if now - t > CLIENT_TIMEOUT]
                for c in dead:
                    CLIENTS.pop(c, None)
                for tid, t in list(TASKS.items()):
                    if t.get("client_id") in dead:
                        try: t["bot"].stop()
                        except: pass
                        TASKS.pop(tid, None)
                for sid, s in list(SESSIONS.items()):
                    if s.get("client_id") in dead:
                        SESSIONS.pop(sid, None)
        except Exception:
            pass

threading.Thread(target=cleanup_worker, daemon=True).start()


HTML = r"""<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Treo Zalo</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',Tahoma,sans-serif;background:linear-gradient(135deg,#1a1a2e,#16213e,#0f3460);min-height:100vh;color:#fff}
.landing{display:flex;align-items:center;justify-content:center;min-height:100vh;cursor:pointer}
.landing h1{font-size:64px;font-weight:900;color:#DB342E;letter-spacing:4px;text-shadow:0 0 20px rgba(219,52,46,.8),0 0 40px rgba(219,52,46,.6)}
.app{display:none;padding:20px;max-width:1400px;margin:0 auto}
.app.show{display:block}
.header{text-align:center;padding:20px;margin-bottom:20px;border-bottom:2px solid rgba(219,52,46,.3)}
.header h1{color:#DB342E;font-size:36px;letter-spacing:2px}
.header p{color:#aaa;margin-top:8px;font-size:14px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}
@media(max-width:900px){.grid{grid-template-columns:1fr}}
.card{background:rgba(255,255,255,.05);border:1px solid rgba(219,52,46,.3);border-radius:16px;padding:24px}
.card h2{color:#DB342E;font-size:20px;margin-bottom:16px;padding-bottom:10px;border-bottom:1px solid rgba(219,52,46,.3)}
.fg{margin-bottom:16px}
.fg label{display:block;margin-bottom:6px;color:#ccc;font-size:14px;font-weight:600}
.fg input,.fg textarea{width:100%;padding:12px 16px;background:rgba(0,0,0,.3);border:1px solid rgba(219,52,46,.4);border-radius:10px;color:#fff;font-size:14px;outline:none;font-family:inherit}
.fg textarea{resize:vertical;min-height:100px}
.btn{padding:12px 24px;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;transition:.3s}
.btn-primary{background:linear-gradient(135deg,#DB342E,#ff5e57);color:#fff}
.btn-primary:disabled{opacity:.5;cursor:not-allowed}
.btn-secondary{background:rgba(255,255,255,.1);color:#fff;border:1px solid rgba(219,52,46,.4)}
.btn-danger{background:linear-gradient(135deg,#c0392b,#e74c3c);color:#fff}
.btn-full{width:100%}
.btn-group{display:flex;gap:10px;flex-wrap:wrap}
.groups-list{max-height:400px;overflow-y:auto;border:1px solid rgba(219,52,46,.3);border-radius:10px;padding:10px;background:rgba(0,0,0,.2)}
.gi{display:flex;align-items:center;padding:10px;border-radius:8px;margin-bottom:6px;background:rgba(255,255,255,.03);cursor:pointer}
.gi:hover{background:rgba(219,52,46,.15)}
.gi input{margin-right:12px;width:18px;height:18px;accent-color:#DB342E}
.gi .gn{font-size:14px;flex:1}
.gi .gid{font-size:11px;color:#888}
.status{padding:12px;border-radius:10px;margin-top:12px;font-size:14px;display:none}
.status.show{display:block}
.status.success{background:rgba(39,174,96,.2);border:1px solid #27ae60;color:#2ecc71}
.status.error{background:rgba(231,76,60,.2);border:1px solid #e74c3c;color:#e74c3c}
.status.loading{background:rgba(241,196,15,.2);border:1px solid #f1c40f;color:#f1c40f}
.task-card{background:rgba(255,255,255,.05);border:1px solid rgba(219,52,46,.3);border-radius:12px;padding:16px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px}
.task-card h3{color:#DB342E;font-size:15px;margin-bottom:4px}
.task-card p{font-size:12px;color:#aaa}
.badge{padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700}
.badge.running{background:#27ae60}
.badge.stopped{background:#7f8c8d}
.empty{text-align:center;padding:30px;color:#666;font-size:14px}
.footer{text-align:center;margin-top:30px;padding:20px;color:#555;font-size:12px}
.footer span{color:#DB342E;font-weight:700}
</style>
</head>
<body>
<div class="landing" id="landing" onclick="openApp()"><h1>TREO ZALO</h1></div>
<div class="app" id="app">
<div class="header"><h1>🔥 TREO ZALO 🔥</h1><p>Tool by Anh Quân</p></div>
<div class="grid">
<div class="card">
<h2>🔐 Đăng nhập</h2>
<div class="fg"><label>📱 IMEI</label><input id="imei" placeholder="IMEI..."></div>
<div class="fg"><label>🍪 Cookie (JSON)</label><textarea id="cookie" placeholder='{"key":"value"}'></textarea></div>
<button class="btn btn-primary btn-full" id="btnLogin" onclick="login()">🚀 Đăng nhập & Lấy nhóm</button>
<div class="status" id="loginStatus"></div>
</div>
<div class="card">
<h2>📋 Nhóm</h2>
<div class="btn-group" style="margin-bottom:10px">
<button class="btn btn-secondary" onclick="selAll(true)">✅ Tất cả</button>
<button class="btn btn-secondary" onclick="selAll(false)">❌ Bỏ</button>
</div>
<div class="groups-list" id="groupsList"><div class="empty">Chưa có nhóm.</div></div>
<p style="margin-top:10px;font-size:13px;color:#aaa">Đã chọn: <span id="selectedCount" style="color:#DB342E;font-weight:700">0</span></p>
</div>
</div>
<div class="card" style="margin-top:20px">
<h2>⚙️ Cấu hình</h2>
<div class="grid">
<div class="fg"><label>📝 Nội dung</label><textarea id="content">🔥 TREO ZALO BY ANH QUÂN 🔥</textarea></div>
<div>
<div class="fg"><label>🔤 Size chữ</label><input type="number" id="fontSize" value="18"></div>
<div class="fg"><label>⏳ Delay (giây)</label><input type="number" id="delay" value="5" step="0.5"></div>
</div>
</div>
<div class="btn-group">
<button class="btn btn-primary" id="btnStart" onclick="startTask()" disabled>🚀 Bắt đầu</button>
<button class="btn btn-secondary" onclick="resetAll()">🔄 Làm mới</button>
</div>
<div class="status" id="startStatus"></div>
</div>
<div class="card" style="margin-top:20px">
<h2>📊 Task</h2>
<div id="tasksList"><div class="empty">Chưa có task.</div></div>
<button class="btn btn-danger btn-full" style="margin-top:12px" onclick="stopAll()">🛑 Dừng tất cả</button>
</div>
<div class="footer">Made with ❤️ by <span>Anh Quân</span></div>
</div>
<script>
let sessionId=null,groups=[],timer=null,hbTimer=null;
let clientId=localStorage.getItem('tz_cid');
if(!clientId){clientId='c_'+Math.random().toString(36).slice(2)+Date.now().toString(36);localStorage.setItem('tz_cid',clientId)}

function openApp(){document.getElementById('landing').style.display='none';document.getElementById('app').classList.add('show');if(!timer)timer=setInterval(refreshTasks,2000);startHb()}
function startHb(){sendHb();if(hbTimer)clearInterval(hbTimer);hbTimer=setInterval(sendHb,5000)}
function sendHb(){fetch('/api/heartbeat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:clientId})}).catch(()=>{})}
window.addEventListener('beforeunload',()=>{const d=JSON.stringify({client_id:clientId});if(navigator.sendBeacon){navigator.sendBeacon('/api/leave',new Blob([d],{type:'application/json'}))}else{fetch('/api/leave',{method:'POST',headers:{'Content-Type':'application/json'},body:d,keepalive:true})}})
function showStatus(id,msg,type){const el=document.getElementById(id);el.className='status show '+type;el.innerHTML=msg}
function hideStatus(id){document.getElementById(id).classList.remove('show')}
function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

async function login(){
const imei=document.getElementById('imei').value.trim();
const cookie=document.getElementById('cookie').value.trim();
if(!imei||!cookie){showStatus('loginStatus','⚠️ Nhập đủ IMEI/Cookie!','error');return}
try{JSON.parse(cookie)}catch(e){showStatus('loginStatus','⚠️ Cookie không phải JSON!','error');return}
const btn=document.getElementById('btnLogin');
btn.disabled=true;btn.textContent='Đang đăng nhập...';
showStatus('loginStatus','⏳ Đang kết nối...','loading');
try{
const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({imei,cookie,client_id:clientId})});
const d=await r.json();
if(d.success){sessionId=d.session_id;groups=d.groups||[];renderGroups(groups);showStatus('loginStatus','✅ '+groups.length+' nhóm','success');document.getElementById('btnStart').disabled=false}
else showStatus('loginStatus','❌ '+(d.error||'Lỗi!'),'error')
}catch(e){showStatus('loginStatus','❌ '+e.message,'error')}
finally{btn.disabled=false;btn.textContent='🚀 Đăng nhập & Lấy nhóm'}
}
function renderGroups(gs){
const el=document.getElementById('groupsList');
if(!gs||!gs.length){el.innerHTML='<div class="empty">Không có nhóm.</div>';return}
el.innerHTML=gs.map((g,i)=>`<div class="gi" onclick="toggleG(${i})"><input type="checkbox" data-idx="${i}" onclick="event.stopPropagation();updateCount()"><div style="flex:1"><div class="gn">${esc(g.name)}</div><div class="gid">${g.id}</div></div></div>`).join('');
updateCount()}
function toggleG(i){const cb=document.querySelector('input[data-idx="'+i+'"]');if(cb)cb.checked=!cb.checked;updateCount()}
function selAll(v){document.querySelectorAll('#groupsList input[type=checkbox]').forEach(c=>c.checked=v);updateCount()}
function updateCount(){document.getElementById('selectedCount').textContent=document.querySelectorAll('#groupsList input[type=checkbox]:checked').length}
function getSelected(){const ids=[];document.querySelectorAll('#groupsList input[type=checkbox]:checked').forEach(cb=>{const i=parseInt(cb.dataset.idx);if(groups[i])ids.push(groups[i].id)});return ids}

async function startTask(){
if(!sessionId){showStatus('startStatus','⚠️ Đăng nhập trước!','error');return}
const sel=getSelected();
if(!sel.length){showStatus('startStatus','⚠️ Chọn nhóm!','error');return}
const content=document.getElementById('content').value.trim();
const fontSize=parseInt(document.getElementById('fontSize').value)||18;
const delay=parseFloat(document.getElementById('delay').value)||5;
const btn=document.getElementById('btnStart');
btn.disabled=true;btn.textContent='Đang tạo...';
try{
const r=await fetch('/api/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:sessionId,client_id:clientId,thread_ids:sel,content,font_size:fontSize,delay})});
const d=await r.json();
if(d.success){showStatus('startStatus','✅ Đã tạo task!','success');refreshTasks()}
else showStatus('startStatus','❌ '+(d.error||'Lỗi!'),'error')
}catch(e){showStatus('startStatus','❌ '+e.message,'error')}
finally{btn.disabled=false;btn.textContent='🚀 Bắt đầu'}
}
async function refreshTasks(){try{const r=await fetch('/api/tasks?client_id='+clientId);const d=await r.json();renderTasks(d.tasks||[])}catch(e){}}
function renderTasks(ts){
const el=document.getElementById('tasksList');
if(!ts||!ts.length){el.innerHTML='<div class="empty">Chưa có task.</div>';return}
el.innerHTML=ts.map(t=>`<div class="task-card"><div style="flex:1"><h3>Task ${t.id.slice(0,8)} <span class="badge ${t.running?'running':'stopped'}">${t.running?'● RUNNING':'● STOPPED'}</span></h3><p>📦 ${t.group_count} nhóm | 📨 ${t.count} tin | ⏱ ${t.delay}s</p><p>📝 ${esc((t.content||'').slice(0,60))}</p></div>${t.running?`<button class="btn btn-danger" onclick="stopTask('${t.id}')">🛑 Dừng</button>`:''}</div>`).join('')}
async function stopTask(id){await fetch('/api/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({task_id:id,client_id:clientId})});refreshTasks()}
async function stopAll(){await fetch('/api/stop_all',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:clientId})});refreshTasks()}
function resetAll(){if(!confirm('Làm mới?'))return;document.getElementById('groupsList').innerHTML='<div class="empty">Chưa có nhóm.</div>';document.getElementById('selectedCount').textContent='0';groups=[];sessionId=null;document.getElementById('btnStart').disabled=true;hideStatus('loginStatus');hideStatus('startStatus')}
</script>
</body>
</html>"""


@app.route('/')
def index():
    return render_template_string(HTML)


@app.route('/api/heartbeat', methods=['POST'])
def api_heartbeat():
    try:
        data = request.get_json() or {}
        cid = data.get('client_id', '')
        if cid:
            with LOCK:
                CLIENTS[cid] = time.time()
        return jsonify({"success": True})
    except Exception:
        return jsonify({"success": False})


@app.route('/api/leave', methods=['POST'])
def api_leave():
    try:
        data = request.get_json() or {}
        cid = data.get('client_id', '')
        if cid:
            with LOCK:
                CLIENTS.pop(cid, None)
                for tid in [t for t, v in TASKS.items() if v.get("client_id") == cid]:
                    try: TASKS[tid]["bot"].stop()
                    except: pass
                    TASKS.pop(tid, None)
                for sid in [s for s, v in SESSIONS.items() if v.get("client_id") == cid]:
                    SESSIONS.pop(sid, None)
        return jsonify({"success": True})
    except Exception:
        return jsonify({"success": False})


@app.route('/api/login', methods=['POST'])
def api_login():
    if not ZLAPI_AVAILABLE:
        err = ""
        try:
            with open("/tmp/zlapi_error.txt") as f:
                err = f.read()
        except: pass
        return jsonify({"success": False, "error": "zlapi chưa load được: " + err})
    try:
        data = request.get_json()
        imei = data.get('imei', '').strip()
        cookie_str = data.get('cookie', '').strip()
        client_id = data.get('client_id', '').strip()
        if not imei or not cookie_str:
            return jsonify({"success": False, "error": "Thiếu IMEI/Cookie!"})
        cookies = json.loads(cookie_str)
        sid = str(uuid.uuid4())
        bot = Bot(imei, cookies, task_id="login_" + sid[:6])
        gids = bot.fetchAllGroupIds()
        if not gids:
            return jsonify({"success": False, "error": "Không lấy được nhóm!"})
        gs = [{"id": g, "name": bot.get_group_name(g)} for g in gids]
        with LOCK:
            SESSIONS[sid] = {"bot": bot, "imei": imei, "cookies": cookies,
                            "groups": gs, "client_id": client_id,
                            "created": datetime.now().isoformat()}
            if client_id:
                CLIENTS[client_id] = time.time()
        return jsonify({"success": True, "session_id": sid, "groups": gs})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


@app.route('/api/start', methods=['POST'])
def api_start():
    try:
        data = request.get_json()
        sid = data.get('session_id', '')
        client_id = data.get('client_id', '')
        tids = data.get('thread_ids', [])
        content = data.get('content', '').strip()
        font_size = int(data.get('font_size', 18))
        delay = float(data.get('delay', 5))
        if not sid or sid not in SESSIONS:
            return jsonify({"success": False, "error": "Session hết hạn!"})
        if not tids or not content or delay < 0.5:
            return jsonify({"success": False, "error": "Thiếu thông tin!"})
        sess = SESSIONS[sid]
        task_id = str(uuid.uuid4())
        task_bot = Bot(sess["imei"], sess["cookies"], task_id=task_id[:8])
        with LOCK:
            TASKS[task_id] = {"bot": task_bot, "thread_ids": tids, "group_count": len(tids),
                            "content": content, "delay": delay, "font_size": font_size,
                            "running": True, "client_id": client_id,
                            "started": datetime.now().isoformat()}
            if client_id:
                CLIENTS[client_id] = time.time()
        threading.Thread(target=task_bot.spam_forever, args=(tids, content, delay, font_size), daemon=True).start()
        return jsonify({"success": True, "task_id": task_id})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


@app.route('/api/tasks')
def api_tasks():
    client_id = request.args.get('client_id', '')
    out = []
    with LOCK:
        if client_id:
            CLIENTS[client_id] = time.time()
        for tid, t in TASKS.items():
            if client_id and t.get("client_id") != client_id:
                continue
            bot = t["bot"]
            out.append({"id": tid, "running": bot.running, "count": bot.spam_count,
                       "group_count": t["group_count"], "delay": t["delay"],
                       "content": t["content"]})
    return jsonify({"tasks": out})


@app.route('/api/stop', methods=['POST'])
def api_stop():
    try:
        data = request.get_json()
        tid = data.get('task_id', '')
        with LOCK:
            if tid in TASKS:
                TASKS[tid]["bot"].stop()
                TASKS[tid]["running"] = False
        return jsonify({"success": True})
    except Exception:
        return jsonify({"success": False})


@app.route('/api/stop_all', methods=['POST'])
def api_stop_all():
    with LOCK:
        for tid, t in TASKS.items():
            try:
                t["bot"].stop()
                t["running"] = False
            except: pass
    return jsonify({"success": True})


@app.route('/api/debug')
def api_debug():
    """Endpoint debug để kiểm tra lỗi"""
    info = {
        "zlapi_available": ZLAPI_AVAILABLE,
        "base_dir": BASE_DIR,
        "zlapi_dir_exists": os.path.isdir(os.path.join(BASE_DIR, "zlapi")),
        "files_in_base": os.listdir(BASE_DIR) if os.path.isdir(BASE_DIR) else [],
        "tasks": len(TASKS),
        "sessions": len(SESSIONS),
    }
    try:
        with open("/tmp/zlapi_error.txt") as f:
            info["zlapi_error"] = f.read()
    except: pass
    return jsonify(info)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False)
