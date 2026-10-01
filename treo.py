#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TREO ZALO WEB - Flask App for Render.com (SILENT MODE)
Single file - No console spam - Modern UI
"""

import os
import sys
import json
import time
import uuid
import logging
import threading
from datetime import datetime

# ========== TẮT TOÀN BỘ LOG/CONSOLE ==========
logging.disable(logging.CRITICAL)

# Tắt log của Flask/Werkzeug
import werkzeug
werkzeug._internal._log = lambda *a, **k: None

# Tắt stdout/stderr nếu cần (tránh Render hiện log)
class NullWriter:
    def write(self, *a, **k): pass
    def flush(self, *a, **k): pass

# Chỉ bật khi debug local, tắt hoàn toàn trên production
if os.environ.get("SILENT_MODE", "1") == "1":
    sys.stdout = NullWriter()
    sys.stderr = NullWriter()

# ========== LOAD ZLAPI ==========
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if os.path.isdir(os.path.join(BASE_DIR, "zlapi")):
    sys.path.insert(0, BASE_DIR)
    sys.path.insert(0, os.path.join(BASE_DIR, "zlapi"))

try:
    from zlapi import ZaloAPI, ThreadType, Message, MessageStyle, MultiMsgStyle
    from zlapi.models import *
    ZLAPI_AVAILABLE = True
except Exception:
    try:
        from zlapi import *
        ZLAPI_AVAILABLE = True
    except Exception:
        ZLAPI_AVAILABLE = False

from flask import Flask, render_template_string, request, jsonify

# ========== FLASK APP ==========
app = Flask(__name__)
app.secret_key = os.urandom(24).hex()

# Tắt log Flask
app.logger.disabled = True
log = logging.getLogger('werkzeug')
log.disabled = True

# ========== GLOBAL STATE ==========
TASKS = {}
SESSIONS = {}
LOCK = threading.Lock()


# ========== BOT CLASS (SILENT) ==========
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
            else:
                try:
                    r = self._call_api('group/getlist', {})
                    if r and 'data' in r:
                        for g in r['data']:
                            if 'groupId' in g:
                                group_ids.append(g['groupId'])
                except Exception:
                    pass
            return group_ids
        except Exception:
            return []

    def get_group_name(self, thread_id):
        try:
            info = super().fetchGroupInfo(thread_id)
            if hasattr(info, 'gridInfoMap') and thread_id in info.gridInfoMap:
                return info.gridInfoMap[thread_id].get("name", "Nhóm %s" % thread_id[:8])
            return "Nhóm %s" % thread_id[:8]
        except Exception:
            return "Nhóm %s" % thread_id[:8]

    def send_styled_message(self, thread_id, text, font_size=18):
        try:
            n = len(text)
            styles = []
            styles.append(MessageStyle(offset=0, length=n, style="color",
                                        color="#DB342E", auto_format=False))
            styles.append(MessageStyle(offset=0, length=n, style="bold",
                                        auto_format=False))
            try:
                styles.append(MessageStyle(offset=0, length=n, style="font",
                                            size=str(font_size), auto_format=False))
            except Exception:
                pass
            msg = Message(text=text, style=MultiMsgStyle(styles))
            self.sendMessage(msg, thread_id=thread_id, thread_type=ThreadType.GROUP)
            self.spam_count += 1
        except Exception:
            try:
                self.sendMessage(Message(text=text), thread_id=thread_id,
                                 thread_type=ThreadType.GROUP)
                self.spam_count += 1
            except Exception:
                pass

    def spam_forever(self, thread_ids, content, delay, font_size=18):
        try:
            self.running = True
            # Gửi lần đầu
            for tid in thread_ids:
                if not self.running: break
                try:
                    self.setTyping(tid, ThreadType.GROUP)
                    time.sleep(0.3)
                    self.send_styled_message(tid, content, font_size)
                except Exception:
                    pass
            # Vòng lặp
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


# ========== HTML ==========
HTML = r"""<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Treo Zalo</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{font-family:'Segoe UI',Tahoma,sans-serif;background:linear-gradient(135deg,#41a1a2e,#16213e,#0sf3460);min-height:100vh;color:#}
fff;overflow-x:hidden}
.landing{display:.flex;align-items:center;justify-content:centerland;min-height:100vh;cursor:ingpointer;transition:.:hover{transform:scale(1.05)}
.landing h1{font-size:72px;font-weight:900;color:#DB342E;letter-spacing:4px;text-shadow:0 0 20px rgba(219,52,46,.8),0 0 40px rgba(219,52,46,.6),0 0 60px rgba(219,52,46,.4);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{text-shadow:0 0 20px rgba(219,52,46,.8),0 0 40px rgba(219,52,46,.6),0 0 60px rgba(219,52,46,.4)}50%{text-shadow:0 0 30px rgba(219,52,46,1),0 0 60px rgba(219,52,46,.8),0 0 90px rgba(219,52,46,.6)}}
.app{display:none;padding:20px;max-width:1400px;margin:0 auto}
.app.show{display:block;animation:fi .5s}
@keyframes fi{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
.header{text-align:center;padding:20px;margin-bottom:20px;border-bottom:2px solid rgba(219,52,46,.3)}
.header h1{color:#DB342E;font-size:36px;text-shadow:0 0 15px rgba(219,52,46,.6);letter-spacing:2px}
.header p{color:#aaa;margin-top:8px;font-size:14px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}
@media(max-width:900px){.grid{grid-template-columns:1fr}}
.card{background:rgba(255,255,255,.05);border:1px solid rgba(219,52,46,.3);border-radius:16px;padding:24px;backdrop-filter:blur(10px);box-shadow:0 8px 32px rgba(0,0,0,.3)}
.card h2{color:#DB342E;font-size:20px;margin-bottom:16px;padding-bottom:10px;border-bottom:1px solid rgba(219,52,46,.3);display:flex;align-items:center;gap:10px}
.fg{margin-bottom:16px}
.fg label{display:block;margin-bottom:6px;color:#ccc;font-size:14px;font-weight:600}
.fg input,.fg textarea,.fg select{width:100%;padding:12px 16px;background:rgba(0,0,0,.3);border:1px solid rgba(219,52,46,.4);border-radius:10px;color:#fff;font-size:14px;font-family:inherit;transition:.3s;outline:none}
.fg input:focus,.fg textarea:focus{border-color:#DB342E;box-shadow:0 0 0 3px rgba(219,52,46,.2)}
.fg textarea{resize:vertical;min-height:100px}
.btn{padding:12px 24px;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;transition:.3s;letter-spacing:.5px}
.btn-primary{background:linear-gradient(135deg,#DB342E,#ff5e57);color:#fff;box-shadow:0 4px 15px rgba(219,52,46,.4)}
.btn-primary:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(219,52,46,.6)}
.btn-primary:disabled{opacity:.5;cursor:not-allowed;transform:none}
.btn-secondary{background:rgba(255,255,255,.1);color:#fff;border:1px solid rgba(219,52,46,.4)}
.btn-secondary:hover{background:rgba(219,52,46,.2)}
.btn-danger{background:linear-gradient(135deg,#c0392b,#e74c3c);color:#fff}
.btn-danger:hover{transform:translateY(-2px)}
.btn-full{width:100%}
.btn-group{display:flex;gap:10px;flex-wrap:wrap}
.groups-list{max-height:400px;overflow-y:auto;border:1px solid rgba(219,52,46,.3);border-radius:10px;padding:10px;background:rgba(0,0,0,.2)}
.groups-list::-webkit-scrollbar{width:8px}
.groups-list::-webkit-scrollbar-track{background:rgba(0,0,0,.2)}
.groups-list::-webkit-scrollbar-thumb{background:#DB342E;border-radius:4px}
.gi{display:flex;align-items:center;padding:10px 12px;border-radius:8px;margin-bottom:6px;background:rgba(255,255,255,.03);transition:.2s;cursor:pointer}
.gi:hover{background:rgba(219,52,46,.15)}
.gi input[type=checkbox]{width:18px;height:18px;margin-right:12px;accent-color:#DB342E;cursor:pointer}
.gi .gn{flex:1;font-size:14px}
.gi .gid{font-size:11px;color:#888}
.status{padding:12px 16px;border-radius:10px;margin-top:12px;font-size:14px;display:none}
.status.show{display:block;animation:fi .3s}
.status.success{background:rgba(39,174,96,.2);border:1px solid #27ae60;color:#2ecc71}
.status.error{background:rgba(231,76,60,.2);border:1px solid #e74c3c;color:#e74c3c}
.status.loading{background:rgba(241,196,15,.2);border:1px solid #f1c40f;color:#f1c40f}
.tasks-section{margin-top:24px}
.task-card{background:rgba(255,255,255,.05);border:1px solid rgba(219,52,46,.3);border-radius:12px;padding:16px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px}
.task-card .ti{flex:1;min-width:200px}
.task-card .ti h3{color:#DB342E;font-size:15px;margin-bottom:4px}
.task-card .ti p{font-size:12px;color:#aaa}
.task-card .ta{display:flex;gap:8px}
.badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700}
.badge.running{background:#27ae60;color:#fff;animation:p2 1.5s infinite}
.badge.stopped{background:#7f8c8d;color:#fff}
@keyframes p2{0%,100%{opacity:1}50%{opacity:.6}}
.spinner{display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:8px}
@keyframes spin{to{transform:rotate(360deg)}}
.empty{text-align:center;padding:30px;color:#666;font-size:14px}
.footer{text-align:center;margin-top:30px;padding:20px;color:#555;font-size:12px}
.footer span{color:#DB342E;font-weight:700}
</style>
</head>
<body>

<div class="landing" id="landing" onclick="openApp()">
  <h1>TREO ZALO</h1>
</div>

<div class="app" id="app">
  <div class="header">
    <h1>🔥 TREO ZALO 🔥</h1>
    <p>Tool by Anh Quân - Spam đa cookie đa box</p>
  </div>

  <div class="grid">
    <div class="card">
      <h2>🔐 Đăng nhập Zalo</h2>
      <div class="fg"><label>📱 IMEI</label><input id="imei" placeholder="Nhập IMEI..." autocomplete="off"></div>
      <div class="fg"><label>🍪 Cookie (JSON)</label><textarea id="cookie" placeholder='{"key":"value"}'></textarea></div>
      <button class="btn btn-primary btn-full" id="btnLogin" onclick="login()">🚀 Đăng nhập & Lấy nhóm</button>
      <div class="status" id="loginStatus"></div>
    </div>

    <div class="card">
      <h2>📋 Danh sách nhóm</h2>
      <div class="btn-group" style="margin-bottom:10px">
        <button class="btn btn-secondary" onclick="selAll(true)">✅ Chọn tất cả</button>
        <button class="btn btn-secondary" onclick="selAll(false)">❌ Bỏ chọn</button>
      </div>
      <div class="groups-list" id="groupsList"><div class="empty">Chưa có nhóm. Vui lòng đăng nhập.</div></div>
      <p style="margin-top:10px;font-size:13px;color:#aaa">Đã chọn: <span id="selectedCount" style="color:#DB342E;font-weight:700">0</span> nhóm</p>
    </div>
  </div>

  <div class="card" style="margin-toplabel><:20px">
input    <h2>⚙️ Cấu hình treo</h2>
    <div class=" typegrid" style="grid-template-columns:1fr 1fr">
      <div class="fg">
        <label>📝 Nội dung tin nhắn</label>
        <textarea id="content">🔥 TREO ZALO BY ANH QUÂN 🔥</textarea>
      </div>
      <div>
        <div class="fg"><label>🔤 Size chữ</="number" id="fontSize" value="18" min="8" max="72"></div>
        <div class="fg"><label>⏳ Delay (giây)</label><input type="number" id="delay" value="5" min="0.5" step="0.5"></div>
      </div>
    </div>
    <div class="btn-group">
      <button class="btn btn-primary" id="btnStart" onclick="startTask()" disabled>🚀 Bắt đầu treo</button>
      <button class="btn btn-secondary" onclick="resetAll()">🔄 Làm mới</button>
    </div>
    <div class="status" id="startStatus"></div>
  </div>

  <div class="tasks-section">
    <div class="card">
      <h2>📊 Task đang chạy</h2>
      <div id="tasksList"><div class="empty">Chưa có task nào.</div></div>
      <button class="btn btn-danger btn-full" style="margin-top:12px" onclick="stopAll()">🛑 Dừng tất cả</button>
    </div>
  </div>

  <div class="footer">Made with ❤️ by <span>Anh Quân</span></div>
</div>

<script>
let sessionId = null, groups = [], timer = null;

function openApp(){
  document.getElementById('landing').style.display='none';
  document.getElementById('app').classList.add('show');
  if(!timer) timer = setInterval(refreshTasks, 2000);
}
function showStatus(id,msg,type){
  const el=document.getElementById(id);
  el.className='status show '+type;
  el.innerHTML=msg;
}
function hideStatus(id){document.getElementById(id).classList.remove('show')}
function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

async function login(){
  const imei=document.getElementById('imei').value.trim();
  const cookie=document.getElementById('cookie').value.trim();
  if(!imei||!cookie){showStatus('loginStatus','⚠️ Nhập đủ IMEI và Cookie!','error');return}
  try{JSON.parse(cookie)}catch(e){showStatus('loginStatus','⚠️ Cookie không phải JSON!','error');return}

  const btn=document.getElementById('btnLogin');
  btn.disabled=true;btn.innerHTML='<span class="spinner"></span> Đang đăng nhập...';
  showStatus('loginStatus','<span class="spinner"></span> Đang kết nối...','loading');

  try{
    const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({imei,cookie})});
    const d=await r.json();
    if(d.success){
      sessionId=d.session_id;groups=d.groups||[];
      renderGroups(groups);
      showStatus('loginStatus','✅ Thành công! '+groups.length+' nhóm.','success');
      document.getElementById('btnStart').disabled=false;
    }else{
      showStatus('loginStatus','❌ '+(d.error||'Thất bại!'),'error');
    }
  }catch(e){showStatus('loginStatus','❌ '+e.message,'error')}
  finally{btn.disabled=false;btn.innerHTML='🚀 Đăng nhập & Lấy nhóm'}
}

function renderGroups(gs){
  const el=document.getElementById('groupsList');
  if(!gs||!gs.length){el.innerHTML='<div class="empty">Không có nhóm.</div>';return}
  el.innerHTML=gs.map((g,i)=>`
    <div class="gi" onclick="toggleG(${i},event)">
      <input type="checkbox" data-idx="${i}" onclick="event.stopPropagation();updateCount()">
      <div style="flex:1">
        <div class="gn">${esc(g.name)}</div>
        <div class="gid">${g.id}</div>
      </div>
    </div>`).join('');
  updateCount();
}
function toggleG(i,ev){
  const cb=document.querySelector('input[data-idx="'+i+'"]');
  if(cb)cb.checked=!cb.checked;
  updateCount();
}
function selAll(v){document.querySelectorAll('#groupsList input[type=checkbox]').forEach(c=>c.checked=v);updateCount()}
function updateCount(){
  const n=document.querySelectorAll('#groupsList input[type=checkbox]:checked').length;
  document.getElementById('selectedCount').textContent=n;
}
function getSelected(){
  const ids=[];
  document.querySelectorAll('#groupsList input[type=checkbox]:checked').forEach(cb=>{
    const i=parseInt(cb.dataset.idx);
    if(groups[i])ids.push(groups[i].id);
  });
  return ids;
}

async function startTask(){
  if(!sessionId){showStatus('startStatus','⚠️ Đăng nhập trước!','error');return}
  const sel=getSelected();
  if(!sel.length){showStatus('startStatus','⚠️ Chọn ít nhất 1 nhóm!','error');return}
  const content=document.getElementById('content').value.trim();
  if(!content){showStatus('startStatus','⚠️ Nhập nội dung!','error');return}
  const fontSize=parseInt(document.getElementById('fontSize').value)||18;
  const delay=parseFloat(document.getElementById('delay').value)||5;

  const btn=document.getElementById('btnStart');
  btn.disabled=true;btn.innerHTML='<span class="spinner"></span> Đang tạo...';
  showStatus('startStatus','<span class="spinner"></span> Đang khởi động...','loading');

  try{
    const r=await fetch('/api/start',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({session_id:sessionId,thread_ids:sel,content,font_size:fontSize,delay})});
    const d=await r.json();
    if(d.success){showStatus('startStatus','✅ Đã tạo task!','success');refreshTasks()}
    else showStatus('startStatus','❌ '+(d.error||'Lỗi!'),'error');
  }catch(e){showStatus('startStatus','❌ '+e.message,'error')}
  finally{btn.disabled=false;btn.innerHTML='🚀 Bắt đầu treo'}
}

async function refreshTasks(){
  try{
    const r=await fetch('/api/tasks');
    const d=await r.json();
    renderTasks(d.tasks||[]);
  }catch(e){}
}
function renderTasks(ts){
  const el=document.getElementById('tasksList');
  if(!ts||!ts.length){el.innerHTML='<div class="empty">Chưa có task nào.</div>';return}
  el.innerHTML=ts.map(t=>`
    <div class="task-card">
      <div class="ti">
        <h3>Task #${t.id.slice(0,8)} <span class="badge ${t.running?'running':'stopped'}">${t.running?'● RUNNING':'● STOPPED'}</span></h3>
        <p>📦 ${t.group_count} nhóm | 📨 ${t.count} tin | ⏱ ${t.delay}s | 🔤 Size ${t.font_size}</p>
        <p>📝 ${esc((t.content||'').slice(0,60))}${t.content&&t.content.length>60?'...':''}</p>
      </div>
      <div class="ta">${t.running?`<button class="btn btn-danger" onclick="stopTask('${t.id}')">🛑 Dừng</button>`:''}</div>
    </div>`).join('');
}
async function stopTask(id){
  await fetch('/api/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({task_id:id})});
  refreshTasks();
}
async function stopAll(){await fetch('/api/stop_all',{method:'POST'});refreshTasks()}
function resetAll(){
  if(!confirm('Làm mới?'))return;
  document.getElementById('groupsList').innerHTML='<div class="empty">Chưa có nhóm.</div>';
  document.getElementById('selectedCount').textContent='0';
  groups=[];sessionId=null;
  document.getElementById('btnStart').disabled=true;
  hideStatus('loginStatus');hideStatus('startStatus');
}
</script>
</body>
</html>"""


# ========== ROUTES ==========
@app.route('/')
def index():
    return render_template_string(HTML)


@app.route('/api/login', methods=['POST'])
def api_login():
    if not ZLAPI_AVAILABLE:
        return jsonify({"success": False, "error": "Thư viện zlapi chưa cài!"})
    try:
        data = request.get_json()
        imei = data.get('imei', '').strip()
        cookie_str = data.get('cookie', '').strip()
        if not imei or not cookie_str:
            return jsonify({"success": False, "error": "Thiếu IMEI/Cookie!"})
        try:
            cookies = json.loads(cookie_str)
        except Exception:
            return jsonify({"success": False, "error": "Cookie JSON không hợp lệ!"})
        if not isinstance(cookies, dict):
            return jsonify({"success": False, "error": "Cookie phải là object!"})

        sid = str(uuid.uuid4())
        bot = Bot(imei, cookies, task_id="login_" + sid[:6])

        gids = bot.fetchAllGroupIds()
        if not gids:
            return jsonify({"success": False, "error": "Không lấy được nhóm! Kiểm tra cookie."})

        gs = []
        for gid in gids:
            gs.append({"id": gid, "name": bot.get_group_name(gid)})

        with LOCK:
            SESSIONS[sid] = {
                "bot": bot,
                "imei": imei,
                "cookies": cookies,
                "groups": gs,
                "created": datetime.now().isoformat(),
            }

        return jsonify({"success": True, "session_id": sid, "groups": gs})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


@app.route('/api/start', methods=['POST'])
def api_start():
    try:
        data = request.get_json()
        sid = data.get('session_id', '')
        tids = data.get('thread_ids', [])
        content = data.get('content', '').strip()
        font_size = int(data.get('font_size', 18))
        delay = float(data.get('delay', 5))

        if not sid or sid not in SESSIONS:
            return jsonify({"success": False, "error": "Session không tồn tại!"})
        if not tids:
            return jsonify({"success": False, "error": "Chưa chọn nhóm!"})
        if not content:
            return jsonify({"success": False, "error": "Chưa nhập nội dung!"})
        if delay < 0.5:
            return jsonify({"success": False, "error": "Delay tối thiểu 0.5s!"})

        sess = SESSIONS[sid]
        task_id = str(uuid.uuid4())

        # Bot mới cho task này (dùng chung cookie)
        task_bot = Bot(sess["imei"], sess["cookies"], task_id=task_id[:8])
        task_bot.spam_count = 0

        with LOCK:
            TASKS[task_id] = {
                "bot": task_bot,
                "thread_ids": tids,
                "group_count": len(tids),
                "content": content,
                "delay": delay,
                "font_size": font_size,
                "running": True,
                "started": datetime.now().isoformat(),
            }

        t = threading.Thread(
            target=task_bot.spam_forever,
            args=(tids, content, delay, font_size),
            daemon=True
        )
        t.start()

        return jsonify({"success": True, "task_id": task_id})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


@app.route('/api/tasks')
def api_tasks():
    out = []
    with LOCK:
        for tid, t in TASKS.items():
            bot = t["bot"]
            out.append({
                "id": tid,
                "running": bot.running,
                "count": bot.spam_count,
                "group_count": t["group_count"],
                "delay": t["delay"],
                "font_size": t["font_size"],
                "content": t["content"],
            })
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
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


@app.route('/api/stop_all', methods=['POST'])
def api_stop_all():
    with LOCK:
        for tid, t in TASKS.items():
            try:
                t["bot"].stop()
                t["running"] = False
            except Exception:
                pass
    return jsonify({"success": True})


# ========== MAIN ==========
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False)
