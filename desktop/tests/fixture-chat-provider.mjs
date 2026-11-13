import http from 'node:http';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

export async function startChatProvider(agent) {
  const requests = [];
  const responseText = 'APP_CHAT_LOCAL_RESPONSE';
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const common = { id:'chatcmpl-app-fixture', created:1, model:'app-chat-local' };
    response.writeHead(200, { 'Content-Type':'text/event-stream' });
    const send = frame => response.write(`data: ${JSON.stringify(frame)}\n\n`);
    send({ ...common, object:'chat.completion.chunk',
      choices:[{index:0,delta:{role:'assistant',content:responseText},finish_reason:null}] });
    send({ ...common, object:'chat.completion.chunk',
      choices:[{index:0,delta:{},finish_reason:'stop'}],
      usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110} });
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const close = async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  try {
    await writeFile(path.join(agent,'models.json'), JSON.stringify({ providers:{
      'app-chat-local':{
        api:'openai-completions', baseUrl:`http://127.0.0.1:${server.address().port}/v1`,
        apiKey:'test-only', models:[{
          id:'app-chat-local',name:'App chat local',reasoning:false,input:['text'],
          contextWindow:200000,maxTokens:512,
          cost:{input:0,output:0,cacheRead:0,cacheWrite:0},
        }],
      },
    } }));
    await writeFile(path.join(agent,'settings.json'), JSON.stringify({
      defaultProvider:'app-chat-local',defaultModel:'app-chat-local',
      retry:{enabled:false},compaction:{enabled:false},cacheWarming:{enabled:false},
    }));
  } catch (error) {
    await close();
    throw error;
  }
  return { requests, responseText, close };
}
