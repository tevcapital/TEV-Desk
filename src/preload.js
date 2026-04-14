const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desk', {
  getAgents: () => ipcRenderer.invoke('agents:get-all'),
  openAgent: (agentId) => ipcRenderer.invoke('agent:open', agentId),
  getAgent: (agentId) => ipcRenderer.invoke('agent:get', agentId),
  getModel: (agentId) => ipcRenderer.invoke('agent:get-model', agentId),
  saveModel: (agentId, model) => ipcRenderer.invoke('agent:save-model', { agentId, model }),
  clearModel: (agentId) => ipcRenderer.invoke('agent:clear-model', agentId),
  uploadDocuments: (agentId) => ipcRenderer.invoke('agent:upload-documents', agentId),
  removeDocument: (agentId, docIndex) => ipcRenderer.invoke('agent:remove-document', { agentId, docIndex }),
  sendMessage: (agentId, messages, newsItems, priceData) => ipcRenderer.invoke('agent:send-message', { agentId, messages, newsItems, priceData }),
  startStream: (agentId, messages, newsItems, priceData, isWarRoom = false) => ipcRenderer.send('agent:start-stream', { agentId, messages, newsItems, priceData, isWarRoom }),
  getWarRoomMessages: () => ipcRenderer.invoke('warroom:get-messages'),
  saveWarRoomMessages: (messages) => ipcRenderer.invoke('warroom:save-messages', { messages }),
  clearWarRoomMessages: () => ipcRenderer.invoke('warroom:clear-messages'),
  getWarRoomDocuments: () => ipcRenderer.invoke('warroom:get-documents'),
  uploadWarRoomDocuments: () => ipcRenderer.invoke('warroom:upload-documents'),
  removeWarRoomDocument: (docIndex) => ipcRenderer.invoke('warroom:remove-document', { docIndex }),
  onStreamChunk: (cb) => ipcRenderer.on('agent:stream-chunk', (_, data) => cb(data)),
  onStreamDone: (cb) => ipcRenderer.once('agent:stream-done', (_, data) => cb(data)),
  onStreamError: (cb) => ipcRenderer.once('agent:stream-error', (_, data) => cb(data)),
  onStreamSearching: (cb) => ipcRenderer.on('agent:stream-searching', (_, data) => cb(data)),
  offStream: () => {
    ipcRenderer.removeAllListeners('agent:stream-chunk');
    ipcRenderer.removeAllListeners('agent:stream-done');
    ipcRenderer.removeAllListeners('agent:stream-error');
    ipcRenderer.removeAllListeners('agent:stream-searching');
  },
  askAll: (question, priceData) => ipcRenderer.send('warroom:ask-all', { question, priceData }),
  onAskAllAgentChunk: (cb) => ipcRenderer.on('askall:agent-chunk', (_, data) => cb(data)),
  onAskAllAgentDone: (cb) => ipcRenderer.on('askall:agent-done', (_, data) => cb(data)),
  onAskAllAgentError: (cb) => ipcRenderer.on('askall:agent-error', (_, data) => cb(data)),
  onAskAllAgentSearching: (cb) => ipcRenderer.on('askall:agent-searching', (_, data) => cb(data)),
  onAskAllResearchDone: (cb) => ipcRenderer.once('askall:research-done', (_, data) => cb(data)),
  onAskAllComplete: (cb) => ipcRenderer.once('askall:complete', (_, data) => cb(data)),
  onAskAllError: (cb) => ipcRenderer.once('askall:error', (_, data) => cb(data)),
  offAskAll: () => {
    ipcRenderer.removeAllListeners('askall:agent-chunk');
    ipcRenderer.removeAllListeners('askall:agent-done');
    ipcRenderer.removeAllListeners('askall:agent-error');
    ipcRenderer.removeAllListeners('askall:agent-searching');
    ipcRenderer.removeAllListeners('askall:research-done');
    ipcRenderer.removeAllListeners('askall:complete');
    ipcRenderer.removeAllListeners('askall:error');
  },
  getMessages: (agentId) => ipcRenderer.invoke('agent:get-messages', agentId),
  saveMessages: (agentId, messages) => ipcRenderer.invoke('agent:save-messages', { agentId, messages }),
  clearMessages: (agentId) => ipcRenderer.invoke('agent:clear-messages', agentId),
  fetchNews: (agentId) => ipcRenderer.invoke('agent:fetch-news', agentId),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getGroqModels: () => ipcRenderer.invoke('settings:get-groq-models'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  getOllamaModels: () => ipcRenderer.invoke('ollama:get-models')
});
