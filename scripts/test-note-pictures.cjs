// Run the local notes-harness.py first; requires Playwright (Chromium and optionally WebKit).
// NODE_PATH=/path/to/node_modules NOTES_BROWSER=webkit node scripts/test-note-pictures.cjs
const { chromium, webkit } = require('playwright');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
(async () => {
 const browser = await (process.env.NOTES_BROWSER === 'webkit' ? webkit : chromium).launch({headless:true});
 const page = await browser.newPage({viewport:{width:1280,height:900}});
 const errors=[]; page.on('pageerror', e => errors.push(e.message));
 await page.goto('http://127.0.0.1:8177/__h');
 await page.locator('#note-editor').waitFor({state:'visible'});
 const image = await page.evaluate(() => {const c=document.createElement('canvas'); c.width=640;c.height=400; const x=c.getContext('2d');x.fillStyle='#e04040';x.fillRect(0,0,640,400);x.fillStyle='white';x.font='32px sans-serif';x.fillText('Picture for notes',50,80); return c.toDataURL().split(',')[1]});
 const file={name:'test-picture.png', mimeType:'image/png',buffer:Buffer.from(image,'base64')};
 const saved=()=>page.evaluate(()=>window.__notesRecords[0].drawing);
 const settle=()=>page.waitForTimeout(850);
 await page.locator('#note-image-input').setInputFiles(file); await settle();
 let d=await saved(); assert.equal(d.pictures.length,1); assert.equal(d.strokes.length,0);
 const initial={...d.pictures[0]};
 assert.equal(await page.locator('#picture-controls').isVisible(),true);
 const box=await page.locator('#ink-canvas').boundingBox();
 const sx=box.x+initial.x+initial.width/2, sy=box.y+initial.y+initial.height/2;
 await page.mouse.move(sx,sy);await page.mouse.down();await page.mouse.move(sx+100,sy+50,{steps:5});await page.mouse.up();await settle();
 d=await saved();assert.ok(Math.abs(d.pictures[0].x-initial.x-100)<1);
 await page.locator('#picture-larger').click();await settle();d=await saved();assert.ok(d.pictures[0].width>initial.width);
 await page.locator('#note-undo').click();await settle();d=await saved();assert.equal(d.pictures[0].width,initial.width);
 await page.locator('#note-redo').click();await settle();d=await saved();assert.ok(d.pictures[0].width>initial.width);
 await page.locator('#picture-done').click();
 const photo=d.pictures[0];
 await page.mouse.move(box.x+photo.x+60,box.y+photo.y+150); await page.mouse.down();await page.mouse.move(box.x+photo.x+240,box.y+photo.y+150,{steps:15});await page.mouse.up();await settle();d=await saved(); assert.equal(d.strokes.length,1);assert.equal(d.pictures.length,1);
 await page.locator('[data-tool=eraser]').click();await page.mouse.move(box.x+photo.x+100,box.y+photo.y+150);await page.mouse.down();await page.mouse.move(box.x+photo.x+180,box.y+photo.y+150,{steps:10});await page.mouse.up();await settle();
 const pixel=await page.evaluate(({x,y})=>{const c=document.querySelector('#ink-canvas');const r=c.getBoundingClientRect();return [...c.getContext('2d').getImageData(x*c.width/r.width,y*c.height/r.height,1,1).data]}, {x:photo.x+140,y:photo.y+150}); assert.ok(pixel[0]>150 && pixel[3]===255, `erasing must reveal the photo: ${pixel}`);
 await page.locator('#note-more').click();const downloadPromise=page.waitForEvent('download');await page.locator('#export-note').click();const download=await downloadPromise;await download.saveAs(join(tmpdir(), 'note-pictures-export.png'));
 await page.locator('[data-tool=image]').click(); await page.mouse.click(box.x+photo.x+50,box.y+photo.y+110);await page.locator('#picture-remove').click();await settle();d=await saved();assert.equal(d.pictures.length,0);assert.equal(d.strokes.length,2);
 await page.locator('#note-undo').click();await settle();d=await saved();assert.equal(d.pictures.length,1);
 await page.locator('#note-back').click();await page.locator('.note-card').waitFor();await page.locator('.note-card').click();await settle();d=await saved();assert.equal(d.pictures.length,1);
 await page.reload();await page.locator('.note-card').waitFor();await page.locator('.note-card').click();await settle();d=await saved();assert.equal(d.pictures.length,1);assert.equal(d.strokes.length,2);
 await page.locator('#note-image-input').setInputFiles({name:'broken.png',mimeType:'image/png',buffer:Buffer.from('broken')});await settle();assert.ok((await page.evaluate(()=>window.__toasts)).some(s=>s.includes('Could not read')));
 // Drop and paste use the same importer, and retain existing pictures.
 await page.evaluate(async (base64)=>{const blob=await (await fetch('data:image/png;base64,'+base64)).blob();const dt=new DataTransfer();dt.items.add(new File([blob],'pasted.png',{type:'image/png'}));document.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));},image);await settle();d=await saved();assert.equal(d.pictures.length,2);
 await page.evaluate(async(base64)=>{const blob=await(await fetch('data:image/png;base64,'+base64)).blob();const dt=new DataTransfer();dt.items.add(new File([blob],'dropped.png',{type:'image/png'}));document.querySelector('#paper').dispatchEvent(new DragEvent('drop',{dataTransfer:dt,clientX:400,clientY:400,bubbles:true,cancelable:true}));},image);await settle();d=await saved();assert.equal(d.pictures.length,3);
 await page.screenshot({path:join(tmpdir(), 'note-pictures-desktop.png')});
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(400);await page.screenshot({path:join(tmpdir(), 'note-pictures-mobile.png')});
 const overflow=await page.evaluate(()=>document.querySelector('.note-editor-head').scrollWidth>innerWidth);assert.equal(overflow,false,'Mobile toolbar must fit');
 assert.deepEqual(errors,[]);
 console.log('PASS: add, drag, resize, undo/redo, ink, eraser, export, remove/restore, reopen/reload, invalid file, paste/drop, mobile fit; no browser errors');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
