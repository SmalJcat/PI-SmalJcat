import assert from 'node:assert/strict';
import path from 'node:path';
import {access,unlink} from 'node:fs/promises';

export async function choosePermission(page,panel,scope,mode) {
  await panel.getByRole('button',{name:`${scope} 权限`,exact:true}).click();
  const menu=page.getByRole('menu',{name:`${scope} 权限设置`,exact:true});
  await menu.locator(`[data-permission-mode="${mode}"]`).click();
  if(mode!=='custom') {await menu.waitFor({state:'hidden'});await page.waitForFunction(label=>document.activeElement?.getAttribute('aria-label')===label,`${scope} 权限`);}
}
export async function composerStatusChecks(page,artifacts,checks,waitForValue) {
  const panel=page.locator('main.main-area:not(.backend-hidden)').first();
  const snapshot=()=>page.evaluate(()=>window.pi.snapshot());
  const policy=()=>page.evaluate(()=>window.pi.permissions());
  const before=await snapshot();assert.equal(before.state.model.provider,'fixture','Permission proof must use the isolated fixture');
  const input=panel.getByRole('textbox',{name:'消息',exact:true}),draft=await input.inputValue();
  const marker=path.join(before.cwd,'approved.txt');
  const exists=async()=>access(marker).then(()=>true,()=>false);
  const settled=()=>waitForValue(snapshot,value=>!value.state.isStreaming);
  await panel.getByRole('button',{name:'Pi 上下文用量',exact:true}).hover();
  const tooltip=page.getByRole('tooltip',{name:'Pi 上下文信息',exact:true});await tooltip.waitFor();
  await tooltip.hover();await page.waitForTimeout(300);assert.equal(await tooltip.isVisible(),true);
  await panel.getByRole('button',{name:'Pi 上下文用量',exact:true}).click();
  let context=page.getByRole('dialog',{name:'Pi 上下文信息',exact:true});await context.waitFor();
  await context.getByRole('progressbar',{name:'Pi 上下文占用',exact:true}).waitFor();
  assert.match(await context.innerText(),/估算/);
  assert.ok((await context.innerText()).includes('200k'));
  assert.doesNotMatch(await context.innerText(),/剩余|触发|会话费用|当前已用 0/);
  assert.ok((await context.boundingBox()).height < 180, 'Context card stays compact');
  await page.screenshot({path:path.join(artifacts,'compact-pi-context.png')});
  await page.keyboard.press('Escape');assert.equal(await panel.getByRole('button',{name:'Pi 上下文用量',exact:true}).evaluate(element=>document.activeElement===element),true);
  const permissions=panel.getByRole('button',{name:'Pi 权限',exact:true});
  await permissions.click();let menu=page.getByRole('menu',{name:'Pi 权限设置',exact:true});assert.equal(await menu.getByRole('menuitemradio').count(),4);
  await page.screenshot({path:path.join(artifacts,'v070-pi-permissions.png')});await page.keyboard.press('Escape');
  assert.equal(await permissions.evaluate(element=>document.activeElement===element),true);
  await input.fill('/permission-write-test');await input.press('Enter');
  const approval=page.getByRole('dialog',{name:'Pi 工具授权',exact:true});await approval.waitFor();
  assert.equal(await exists(),false,'No write happens before approval');
  await approval.getByRole('button',{name:'拒绝',exact:true}).click();await settled();assert.equal(await exists(),false);
  await input.fill('/permission-write-test');await input.press('Enter');await approval.waitFor();
  await page.evaluate(()=>{const original=window.pi.permissions;window.pi.permissions=async options=>{if(options?.action==='reply'){window.pi.permissions=original;throw new Error('PERMISSION_REPLY_RETRY');}return original(options);};});
  await approval.getByRole('button',{name:'允许一次',exact:true}).click();
  await approval.getByRole('alert').filter({hasText:'PERMISSION_REPLY_RETRY'}).waitFor();
  assert.equal((await policy()).requests.length,1,'An unsuccessful reply stays available for retry');assert.equal(await exists(),false);
  await approval.getByRole('button',{name:'允许一次',exact:true}).click();await settled();assert.equal(await exists(),true);await unlink(marker);
  await input.fill('/permission-write-test');await input.press('Enter');await approval.waitFor();
  const old=(await policy()).requests[0].id;
  await approval.getByRole('button',{name:'停止任务',exact:true}).click();await settled();await approval.waitFor({state:'hidden'});
  assert.equal(await exists(),false);
  assert.equal(await page.evaluate(async id=>{try{await window.pi.permissions({action:'reply',id,allow:true});return true;}catch{return false;}},old),false,'Cancelled approval ids never authorize a later tool');
  await choosePermission(page,panel,'Pi','smart');await waitForValue(policy,p=>p.mode==='smart');
  await input.fill('/permission-write-test');await input.press('Enter');await settled();assert.equal(await exists(),true);await unlink(marker);
  await choosePermission(page,panel,'Pi','custom');const custom=page.getByRole('dialog',{name:'Pi 自定义权限',exact:true});
  await custom.getByLabel('自动允许工作区常规文件编辑',{exact:true}).check();
  await custom.getByLabel('Pi 禁止工具',{exact:true}).fill('write');await custom.getByRole('button',{name:'保存并启用',exact:true}).click();
  await waitForValue(policy,p=>p.mode==='custom');await input.fill('/permission-write-test');await input.press('Enter');await settled();assert.equal(await exists(),false,'Custom deny has precedence over workspace auto-edit');
  await choosePermission(page,panel,'Pi','full-access');await waitForValue(policy,p=>p.mode==='full-access');
  await input.fill('/permission-write-test');await input.press('Enter');await settled();assert.equal(await exists(),true);await unlink(marker);
  await choosePermission(page,panel,'Pi','ask');await waitForValue(policy,p=>p.mode==='ask');await input.fill(draft);
  checks.push('Pi 四种权限在执行前真实拦截：拒绝不落盘、允许一次后写入、停止清除旧请求，自动/自定义/完全访问策略生效');
  await input.fill('/metrics-test');await input.press('Enter');await settled();
  const metrics=panel.getByLabel('Pi 模型统计',{exact:true});
  await waitForValue(()=>metrics.getByTestId('model-speed').innerText(),text=>/\d+\.\d tok\/s/.test(text));
  await waitForValue(()=>metrics.getByTestId('model-cost').innerText(),text=>/^\$/.test(text)&&Number(text.slice(1))>=.0123);
  const viewport=page.viewportSize();
  for(const width of [1440,1024]) {
    await page.setViewportSize({width,height:viewport.height});
    const geometry=await metrics.evaluate(element=>{const box=element.getBoundingClientRect(),footer=element.closest('.composer-footer').getBoundingClientRect();return {left:box.left,right:box.right,bottom:box.bottom,footerLeft:footer.left,footerRight:footer.right,footerBottom:footer.bottom};});
    assert.ok(geometry.left>=geometry.footerLeft&&geometry.right<=geometry.footerRight+1&&geometry.bottom<=geometry.footerBottom+1,JSON.stringify(geometry));
    await page.screenshot({path:path.join(artifacts,`composer-metrics-${width}.png`)});
  }
  await page.setViewportSize(viewport);await input.fill(draft);
  checks.push('精简上下文卡片无重复用量或费用；底部真实回复速度与会话花费，1440/1024px 布局无溢出');
  checks.push('权限菜单键盘/Escape 焦点恢复、上下文窗口/估算来源与圆环信息卡可用');
  await page.getByRole('button',{name:'子代理工作台',exact:true}).click();
  const agentPanel=page.getByRole('dialog',{name:'子代理工作台',exact:true});await agentPanel.waitFor();
  const created=await page.evaluate(()=>window.pi.agentTasks({action:'start',role:'verifier',tasks:['[child-permission] verify approval ownership']}));
  const taskId=created.tasks[0].id;
  await approval.waitFor();assert.match(await approval.innerText(),/子代理/);
  await page.keyboard.press('Tab');assert.equal(await approval.evaluate(element=>element.contains(document.activeElement)),true,'The top approval modal owns keyboard focus');
  assert.equal((await policy()).requests[0].owner,taskId);
  await approval.getByRole('button',{name:'停止任务',exact:true}).click();
  await waitForValue(()=>page.evaluate(id=>window.pi.agentTasks({action:'detail',id}),taskId),task=>task.status==='cancelled');
  await approval.waitFor({state:'hidden'});
  await agentPanel.getByRole('button',{name:'关闭弹窗',exact:true}).click();
  checks.push('子代理独立进程加载权限门，授权请求标注来源，取消该子任务不误操作主会话');
}
