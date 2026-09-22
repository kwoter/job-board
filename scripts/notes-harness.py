"""Local test bench for the notes editor: serves the repo on http://127.0.0.1:8177 and, at /__h,
the real index.html with a fake Supabase so the editor opens on a blank note with no PIN or network.
Run: python3 scripts/notes-harness.py, then drive it with Playwright or any browser."""
import http.server, re, pathlib, functools
SRC = pathlib.Path(__file__).resolve().parent.parent
BOOT = """<style>#lock,.lock,#lock-screen,.lock-screen{display:none!important}</style>
<script type="module">
import { initNotes } from './notes.js';
const records = JSON.parse(sessionStorage.getItem('notes-harness-records') || '[]');
window.__notesRecords = records;
const ok = Promise.resolve({ data: [], error: null });
const persist = (record) => {
  const index = records.findIndex((item) => item.id === record.id);
  if (index < 0) records.push(structuredClone(record)); else records[index] = structuredClone(record);
  sessionStorage.setItem('notes-harness-records', JSON.stringify(records));
  return ok;
};
const q = { select(){return q}, order(){return Promise.resolve({data: structuredClone(records), error: null})}, insert: persist, upsert: persist, delete(){return q}, eq(){return ok}, then(r){return ok.then(r)} };
const supabase = { from(){return q}, auth:{ getUser: async()=>({data:{user:{id:'u'}}}) }, channel(){ const c={on(){return c}, subscribe(){return c}}; return c; }, removeChannel(){} };
window.__toasts = [];
initNotes({ supabase, toast: (m) => window.__toasts.push(m) });
document.getElementById('app-view').hidden = false;
document.querySelectorAll('.app-screen').forEach((el) => { el.hidden = el.id !== 'notes-screen'; });
setTimeout(() => {
  if (!records.length) document.getElementById('new-note').click();
  else document.querySelector('.app-switch[data-screen="notes"]').click();
}, 150);
</script>"""
class H(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/__h'):
            h = (SRC/"index.html").read_text()
            h = re.sub(r"<script\b[^>]*>.*?</script>", "", h, flags=re.S).replace("</body>", BOOT + "</body>")
            b = h.encode(); self.send_response(200); self.send_header("Content-Type","text/html"); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b); return
        super().do_GET()
    def end_headers(self):
        self.send_header("Cache-Control","no-store"); super().end_headers()
    def log_message(self,*a): pass
http.server.ThreadingHTTPServer(("127.0.0.1", 8177), functools.partial(H, directory=str(SRC))).serve_forever()
