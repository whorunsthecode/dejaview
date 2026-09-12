import { send, on } from '../shared/messages.js';
import { isTab } from '../shared/types.js';
import { MAX_PEEK_CHARS } from '../shared/peek.js';

/**
 * @typedef {object} TabSource
 * @property {() => Promise<Array<import('../shared/types.js').Tab>>} list
 * @property {(id: number) => Promise<{id:number,text:string|null,textStatus:string}>} read
 * @property {(id: number) => Promise<{id:number,description:string,heading:string,paragraph:string,textStatus:string}>} [peek]
 */
export class StubTabSource {
  constructor(url = new URL('../shared/stubs.json', import.meta.url)) { this.url = url; }
  async list() {
    const { readFile } = await import('node:fs/promises');
    const tabs = JSON.parse(await readFile(this.url, 'utf8'));
    tabs.forEach(isTab);
    return tabs;
  }
  async read(id) {
    const tab = (await this.list()).find(tab => tab.id === id);
    if (!tab) throw new Error(`Unknown tab ${id}`);
    return { id, text: tab.text, textStatus: tab.textStatus };
  }
  async peek(id) {
    const tab = (await this.list()).find(tab => tab.id === id);
    if (!tab) throw new Error(`Unknown tab ${id}`);
    return { id, description: '', heading: '', paragraph: (tab.text ?? '').slice(0, MAX_PEEK_CHARS), textStatus: tab.textStatus };
  }
}

/**
 * The current shared bus has no tab RPC contract. The browser owner supplies:
 * requestType, responseType (existing shared MSG values), encodeRequest({requestId,operation,id}),
 * and decodeResponse(payload) -> null | {requestId,result,error}.
 * No wire payload is invented here. Subscribe before sending; always unsubscribe.
 */
export class MessageTabSource {
  constructor({ protocol, sendMessage = send, onMessage = on, timeoutMs = 10000 }) {
    if (!protocol?.encodeRequest || !protocol?.decodeResponse || !protocol.requestType || !protocol.responseType) {
      throw new Error('MessageTabSource requires an agreed tab request/reply protocol');
    }
    Object.assign(this, { protocol, sendMessage, onMessage, timeoutMs });
  }
  list() { return this.request('list'); }
  read(id) { return this.request('read', id); }
  peek(id) { return this.request('peek', id); }
  request(operation, id) {
    const requestId = globalThis.crypto.randomUUID();
    const p = this.protocol;
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const finish = (error, result) => {
        clearTimeout(timer); unsubscribe();
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error(`Tab source ${operation} timed out`)), this.timeoutMs);
      try {
        unsubscribe = this.onMessage(p.responseType, payload => {
          try {
            const response = p.decodeResponse(payload);
            if (response?.requestId !== requestId) return;
            finish(response.error ? new Error(String(response.error)) : null, response.result);
          } catch (error) { finish(error); }
        });
        Promise.resolve(this.sendMessage(p.requestType, p.encodeRequest({ requestId, operation, id })))
          .catch(error => finish(error));
      } catch (error) { finish(error); }
    });
  }
}
