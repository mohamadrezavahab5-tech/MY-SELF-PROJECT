'use strict';
// In-process event bus. Core code emits business events here; integrations
// (webhooks, CRM/call-center connectors) subscribe without the core knowing
// about them. Listeners must never throw into the emitter's caller.
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(50);

// Event names and payloads (all include botId and userId of the bot owner):
//   lead.created            { lead: { id, name, phone, message, sessionId, createdAt } }
//   conversation.handoff    { conversation: { id, sessionId, channel, visitorName, visitorPhone, pageUrl }, online }
//   conversation.closed     { conversation: { id, sessionId, channel } }
//   message.created         { conversation: { id, sessionId, channel }, message: { id, sender, text, createdAt } }
//   question.unanswered     { question, sessionId, channel, type }   // suggest | fallback | limit
function emit(name, payload) {
  setImmediate(() => {
    try {
      bus.emit(name, payload);
    } catch (e) {
      console.error(`[events] ${name} listener failed:`, e.message);
    }
  });
}

function on(name, fn) {
  bus.on(name, (...args) => {
    Promise.resolve().then(() => fn(...args)).catch(e => console.error(`[events] ${name} listener failed:`, e.message));
  });
}

module.exports = { emit, on };
