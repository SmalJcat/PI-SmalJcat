import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { webviewDebugEndpoint } from './tauri-harness.mjs';

export async function mcpAppsChecks(page, profile, artifacts, checks, errors) {
  await page.getByRole('button',{name:'MCP 连接',exact:true}).click();
  const dialog = page.getByRole('dialog',{name:'MCP 连接',exact:true});
  await dialog.getByRole('tab',{name:'桌面调试',exact:true}).click();
  const server = dialog.locator('.mcp-server').filter({has:page.getByText('app-server',{exact:true})});
  await server.getByRole('button',{name:'连接',exact:true}).click();
  await server.locator('.mcp-tool').filter({has:page.getByText('app_view',{exact:true})}).click();
  await server.getByLabel('工具参数 JSON').fill('{"count":7}');
  await server.getByRole('button',{name:'调用工具',exact:true}).click();
  await server.locator('.mcp-result').filter({hasText:'App server result'}).waitFor();
  await server.getByRole('button',{name:'打开 MCP App',exact:true}).click();
  const grants = server.getByRole('region',{name:'MCP App 授权'});
  assert.equal(await grants.getByRole('checkbox',{checked:true}).count(),0);
  assert.equal(await grants.getByRole('checkbox',{name:/model_only/}).count(),0);
  await page.screenshot({path:path.join(artifacts,'mcp-app-grants.png')});

  const target = async label => {
    const url = await webviewDebugEndpoint(path.join(profile,'widgets',label));
    const browser = await chromium.connectOverCDP(url);
    const context = browser.contexts()[0];
    const child = context.pages()[0] || await context.waitForEvent('page');
    child.on('pageerror', error => { errors.push(error.message); console.error('App renderer:',error.stack); });
    return {child,browser};
  };
  const open = async () => {
    const id = await grants.getAttribute('data-app-id');
    await grants.getByRole('button',{name:'打开独立窗口',exact:true}).click();
    return target('widget-app-'+id);
  };
  let opened = await open();
  let child = opened.child;
  let frame = child.frameLocator('iframe[title="MCP App"]');
  await frame.locator('#initial').filter({hasText:'"count":7'}).waitFor();
  await frame.locator('#isolation').filter({hasText:'parent-isolated'}).waitFor();
  const frameEscaped = await frame.locator('body').evaluate(async () => {
    if (typeof window.__TAURI_INTERNALS__?.invoke !== 'function') return false;
    // Some WebView2 subframe native calls have no callback route. The public
    // App channel uses postMessage; this escape probe must itself be bounded.
    return Promise.race([
      window.__TAURI_INTERNALS__.invoke('pi_command',{operation:'bootstrap',payload:{}})
        .then(()=>true,()=>false),
      new Promise(resolve=>setTimeout(()=>resolve(false),300)),
    ]);
  });
  assert.equal(frameEscaped,false);
  await frame.getByRole('button',{name:'刷新服务器数据',exact:true}).click();
  await frame.locator('#output').filter({hasText:'未获授权'}).waitFor();
  assert.deepEqual(errors,[],'App must load without framework errors');
  await grants.getByRole('button',{name:'关闭 App',exact:true}).click();
  await opened.browser.close();
  await page.waitForTimeout(300);
  assert.deepEqual(errors,[],'Native teardown must not create a new frame document');
  await server.getByRole('button',{name:'打开 MCP App',exact:true}).click();
  await grants.getByRole('checkbox',{name:/app_refresh/}).check();
  opened = await open();
  child = opened.child;
  frame = child.frameLocator('iframe[title="MCP App"]');
  await frame.locator('#initial').filter({hasText:'"count":7'}).waitFor();
  await frame.getByRole('button',{name:'刷新服务器数据',exact:true}).click();
  await frame.locator('#output').filter({hasText:'"count":42'}).waitFor();
  await child.screenshot({path:path.join(artifacts,'mcp-app-window.png')});
  await frame.getByRole('button',{name:'调用未授权工具',exact:true}).click();
  await frame.locator('#output').filter({hasText:'未获授权'}).waitFor();
  await frame.getByRole('button',{name:'请求宿主文件',exact:true}).click();
  await frame.locator('#output').filter({hasText:'App 方法不可用'}).waitFor();
  const mainDenied = await child.evaluate(async () => {
    try {
      await window.__TAURI_INTERNALS__.invoke('pi_command',{operation:'bootstrap',payload:{}});
      return false;
    } catch { return true; }
  });
  assert.equal(mainDenied,true);
  const denialAudit = await page.evaluate(()=>window.pi.widgetAudit(100));
  assert.ok(denialAudit.entries.some(entry=>entry.api.endsWith('::bootstrap') && !entry.ok));
  await child.screenshot({path:path.join(artifacts,'mcp-app-rejections.png')});
  await server.getByRole('button',{name:'断开',exact:true}).click();
  await frame.getByRole('button',{name:'刷新服务器数据',exact:true}).click();
  await frame.locator('#output').filter({hasText:'断开'}).waitFor();
  await child.getByRole('button',{name:'关闭 App',exact:true}).click();
  await page.waitForTimeout(400);
  const audit = await page.evaluate(()=>window.pi.widgetAudit(100));
  await opened.browser.close();
  assert.ok(audit.entries.some(entry=>entry.api.endsWith('::close')));
  const legacy = await page.evaluate(()=>window.pi.widgetOpen({
    widget:'fixture.weather',requested:['setWidgetData'],granted:['setWidgetData'],
  }));
  const demo = await target(legacy.label);
  await demo.child.locator('#widget-id').filter({hasText:'fixture.weather'}).waitFor();
  await demo.child.locator('#set-data').click();
  await demo.child.locator('#log').filter({hasText:'✓ setWidgetData'}).waitFor();
  await demo.child.locator('#escape-run').click();
  await demo.child.locator('#log').filter({hasText:'未获授权'}).waitFor();
  await page.evaluate(()=>window.pi.widgetClose('fixture.weather'));
  await demo.browser.close();
  await dialog.getByRole('button',{name:'关闭弹窗',exact:true}).click();
  checks.push('真实 MCP App 资源、初始化输入/结果、默认拒绝与逐项授权、同服务器工具调用');
  checks.push('App iframe 来源隔离、主窗 IPC 拒绝、未知方法、断线与窗口关闭清理');
  checks.push('旧 widget 演示真实 IPC、已授权调用及越权拒绝兼容');
}
