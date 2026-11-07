export function createFixture() {
const tasks = Array.from({ length: 45 }, (_, index) => ({
  id: `task-${String(index).padStart(2, '0')}`, task: `探子记录 ${String(index).padStart(2, '0')}`,
  status: index === 0 ? 'running' : index === 1 ? 'interrupted' : 'completed',
  cwd: index % 2 ? '/fixture/other' : '/fixture/work', model: 'fixture/model', thinking: 'high', attempts: 1,
  output: `预览 ${index}`, truncated: true, tools: [], createdAt: Date.now() - index, archivedAt: null, canResume: index === 1,
}));
const fullText = '中文🙂'.repeat(20000) + 'RESULT_END';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let outputDelay = 0;
  return { fullText, setOutputDelay: value => { outputDelay = value; }, agentTasks: async data => {
    const row = tasks.find(task => task.id === data.id);
    if (data.action === 'definition') return { thinking: 'high' };
    if (data.action === 'detail') return structuredClone(row);
    if (data.action === 'list') {
      if (data.query === 'slow') await wait(350);
      const filtered = tasks.filter(task => (!data.query || `${task.id} ${task.task} ${task.model} ${task.cwd}`.toLowerCase().includes(data.query.toLowerCase())) && (!data.cwd || task.cwd === data.cwd) && (data.archive === 'all' || (data.archive === 'archived' ? !!task.archivedAt : !task.archivedAt)) && (data.status === 'all' || data.status === 'active' && task.status === 'running' || data.status === 'attention' && task.status === 'interrupted' || data.status === task.status));
      const totalPages = Math.max(1, Math.ceil(filtered.length / data.pageSize)), page = Math.min(data.page, totalPages);
      return { tasks: structuredClone(filtered.slice((page - 1) * data.pageSize, page * data.pageSize)), page, totalPages, pageSize: data.pageSize, total: filtered.length, active: 1, concurrency: 4 };
    }
    if (data.action === 'output') {
      await wait(outputDelay);
      const bytes = new TextEncoder().encode(fullText); let end = Math.min(bytes.length, data.offset + 65536);
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
      return { text: new TextDecoder().decode(bytes.subarray(data.offset, end)), nextOffset: end < bytes.length ? end : null, offset: data.offset, totalBytes: bytes.length, version: 'fixture-version', source: 'session' };
    }
    if (['archive', 'restore'].includes(data.action)) {
      if (row.status !== 'completed') throw new Error('Only completed tasks can be archived'); row.archivedAt = data.action === 'archive' ? Date.now() : null; return structuredClone(row);
    }
    throw new Error(`Unexpected fixture operation: ${data.action}`);
  }};
}
