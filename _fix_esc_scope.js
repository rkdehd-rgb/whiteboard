const fs = require('fs');
let p = fs.readFileSync('whiteboard.html', 'utf8');

/* 1) 从 editingId 分支里移除误放的那段 */
const a = `  if(editingId){
    if(e.key === 'Escape'){
      e.preventDefault();
      if(drag.kind === 'shapeDraw'){       // 拖拽建图中按 Esc：取消，不创建
        drag.kind = null; drag.preview = null; guides = []; drawOverlay();
      }
      endEdit();
    }
    return;
  }`;
const b = `  if(editingId){
    if(e.key === 'Escape'){ e.preventDefault(); endEdit(); }
    return;
  }`;
if (p.split(a).length - 1 !== 1) { console.log('miss editing branch'); process.exit(1); }
p = p.split(a).join(b);

/* 2) 在最外层处理：拖拽建图中按 Esc 取消 */
const c = `document.addEventListener('keydown', e=>{
  if(editingId){`;
const d = `document.addEventListener('keydown', e=>{
  // 拖拽建图中按 Esc：取消，不创建（必须在 editingId 判断之前，否则拖拽时不会走到）
  if(e.key === 'Escape' && drag.kind === 'shapeDraw'){
    e.preventDefault();
    drag.kind = null; drag.preview = null; guides = []; drawOverlay();
    return;
  }
  if(editingId){`;
if (p.split(c).length - 1 !== 1) { console.log('miss keydown head'); process.exit(1); }
p = p.split(c).join(d);

fs.writeFileSync('whiteboard.html', p, 'utf8');
console.log('esc scope fixed');
