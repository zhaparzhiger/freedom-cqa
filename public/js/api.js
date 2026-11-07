// Обёртка над REST API. Адрес сервера можно переопределить через window.CQA_CONFIG.apiBase
// (нужно, когда интерфейс встроен в другую систему, например в Dynamics 365).
const base = () => (window.CQA_CONFIG?.apiBase || '').replace(/\/$/, '');

async function request(method, path, body) {
  const res = await fetch(base() + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}

export const api = {
  meta: () => request('GET', '/api/meta'),
  conversations: () => request('GET', '/api/conversations'),
  conversation: (id) => request('GET', `/api/conversations/${encodeURIComponent(id)}`),
  evaluation: (id) => request('GET', `/api/evaluations/${id}`),
  raw: (id) => request('GET', `/api/evaluations/${id}/raw`),
  importGroup: (groupId) => request('POST', '/api/import', { groupId }),
  upload: (payload, group) => request('POST', '/api/upload', { payload, group }),
  evaluate: (conversationId, checklistId, { mode, votes } = {}) => request('POST', '/api/evaluate', { conversationId, checklistId, mode, votes }),
  startJob: (opts) => request('POST', '/api/jobs', opts),
  job: (id) => request('GET', `/api/jobs/${id}`),
  jobs: () => request('GET', '/api/jobs'),
  checklists: () => request('GET', '/api/checklists'),
  createChecklist: (body) => request('POST', '/api/checklists', body),
  saveChecklist: (id, body) => request('PUT', `/api/checklists/${id}`, body),
  activateChecklist: (id) => request('POST', `/api/checklists/${id}/activate`),
  deleteChecklist: (id) => request('DELETE', `/api/checklists/${id}`),
  appeals: (status) => request('GET', `/api/appeals${status ? `?status=${status}` : ''}`),
  createAppeal: (body) => request('POST', '/api/appeals', body),
  decide: (id, body) => request('POST', `/api/appeals/${id}/decision`, body),
  stats: () => request('GET', '/api/stats'),
  learning: () => request('GET', '/api/learning'),
  replay: () => request('POST', '/api/learning/replay'),
  parity: () => request('GET', '/api/parity'),
  startParity: (body) => request('POST', '/api/parity', body),
  createTraining: (evaluationId) => request('POST', '/api/trainings', { evaluationId }),
  impact: (id, draft) => request('POST', `/api/checklists/${id}/impact`, { draft }),
  impactJob: (jobId) => request('GET', `/api/impact/${jobId}`),
  applyImpact: (id, draft, jobId) => request('POST', `/api/checklists/${id}/apply-impact`, { draft, jobId }),
  audioUrl: (id) => `${base()}/api/audio/${encodeURIComponent(id)}`,
  exportUrl: (format) => `${base()}/api/export?format=${format}`,
  resultsUrl: (group) => `${base()}/api/results?download=1${group ? `&group=${encodeURIComponent(group)}` : ''}`,
};
