// Public templates fail closed until the owner configures both allowlist IDs in n8n.
export const telegramGuardCode = `
const allowedUserId = "CONFIGURE_OWNER_USER_ID";
const allowedChatId = "CONFIGURE_OWNER_CHAT_ID";
const update = $input.first().json;
if (!update || typeof update !== 'object' || !Number.isSafeInteger(update.update_id) || update.update_id < 0) return [];
const message = update && update.message;
const validId = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
if (!/^[1-9]\\d{0,15}$/.test(allowedUserId) || !/^[1-9]\\d{0,15}$/.test(allowedChatId)) return [];
if (!message || !message.from || !message.chat || message.chat.type !== 'private' || message.from.is_bot === true) return [];
if (!validId(message.from.id) || !validId(message.chat.id) || String(message.from.id) !== allowedUserId || String(message.chat.id) !== allowedChatId) return [];
if (typeof message.text !== 'string' || message.text.length > 500) return [];
const text = message.text.trim();
if (!text.startsWith('/')) return [];
const help = text === '/start' || text === '/help' || !/^\\/(?:status|today|prep|draft|confirm|done|cancel)(?:\\s|$)/.test(text);
return [{json:{reply_chat_id:allowedChatId,help,telegram_update_id:update.update_id,telegram_channel_id:'tend-course-control',command:{owner_id:'demo-owner',user_id:'demo-user',chat_id:'demo-private',chat_type:'private',text:help?'/status':text}}}];
`;
export const telegramLiveGuardCode = telegramGuardCode
  .replace(
    "status|today|prep|draft|confirm|done|cancel",
    "status|today|contacts|prep|draft|confirm|done|cancel",
  )
  .replace("demo-owner", "CONFIGURE_LIVE_PRINCIPAL_ID")
  .replace("demo-user", "live-owner")
  .replace("demo-private", "live-private")
  .replace("tend-course-control", "CONFIGURE_LIVE_CHANNEL_ID")
  .replace(
    "const update =",
    `if (!/^[A-Za-z0-9_-]{1,100}$/.test("CONFIGURE_LIVE_PRINCIPAL_ID") || "CONFIGURE_LIVE_PRINCIPAL_ID".startsWith("CONFIGURE_") || !/^[a-z0-9-]{1,80}$/.test("CONFIGURE_LIVE_CHANNEL_ID")) return [];\nconst update =`,
  );

export const telegramReplyCode = `
const authorized = $('Authorize Telegram owner').first().json;
if (!authorized || typeof authorized.reply_chat_id !== 'string' || !/^[1-9]\\d{0,15}$/.test(authorized.reply_chat_id)) throw new Error('missing authorized reply destination');
const reply = $input.first().json;
const record = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const string = value => typeof value === 'string' ? value : '';
const lines = ['Course demo • fictional data'];
if(authorized.help) lines.push('Commands: /status, /today, /prep F17, /confirm ID YYYY-MM-DD, /draft ID, /done ID, /cancel ID.','Your private control chat uses fictional evidence only. No personal inbox history is imported.');
else if(!record(reply) || reply.error) lines.push('Command failed. Check the command and local service. Use /help for examples.');
else {
 if(record(reply.counts)) lines.push('Source records: ' + reply.counts.interactions + '. Promise candidates: ' + reply.counts.commitments + '.');
 if(record(reply.contact)) lines.push('Contact: ' + string(reply.contact.name) + ' (' + string(reply.contact.contact_id) + ').');
 if(typeof reply.clock === 'string') lines.push('Fixture clock: ' + reply.clock + '.');
 if(Array.isArray(reply.sources) || Array.isArray(reply.coverage)) {
   const sources = Array.isArray(reply.sources) ? reply.sources : reply.coverage;
   lines.push('Sources:'); for(const source of sources.filter(record)) lines.push(string(source.source) + ': ' + string(source.status) + ', ' + string(source.mode) + '.');
 }
 const commitments = Array.isArray(reply.commitments) ? reply.commitments : [];
 const pending = Array.isArray(reply.pending) ? reply.pending : [];
 if(commitments.length || pending.length) {
   lines.push('Promises:'); for(const item of [...commitments,...pending].filter(record)) {const date = item.due_date ? 'due ' + string(item.due_date) : item.suggested_due ? 'proposed date ' + string(item.suggested_due) + ' (unconfirmed)' : 'date not confirmed';lines.push(string(item.commitment_id) + ': ' + (item.direction === 'owed_by_me' ? 'You owe' : 'Owed to you') + ' ' + string(item.action) + '. ' + string(item.status) + '; ' + date + '.');}
 }
 if(Array.isArray(reply.meetings)) {lines.push('Upcoming fixture meetings:');if(!reply.meetings.length) lines.push('None in the fixture window.');for(const item of reply.meetings.filter(record))lines.push(string(item.occurred_at) + ': ' + string(item.body_text));}
 if(Array.isArray(reply.evidence)) {lines.push('Evidence:');for(const item of reply.evidence.filter(record))lines.push(string(item.source) + ': ' + string(item.text) + ' [' + string(item.reference) + ']');}
 if(typeof reply.commitment_id === 'string')lines.push(reply.commitment_id + ': ' + string(reply.status) + '. Due ' + (reply.due_date || 'not confirmed') + '.',string(reply.action));
 if(typeof reply.preview === 'string')lines.push('Private draft preview only. Nothing sent to a contact.',reply.preview);
 if(typeof reply.warning === 'string')lines.push(reply.warning);
}
let text = lines.join('\\n');
if(text.length > 3900) text = text.slice(0,3800).replace(/[\\uD800-\\uDBFF]$/, '') + '\\n… Reply shortened. Ask for a narrower contact or task.';
const escaped = []; let length=0;
for(const character of text){const safe=character==='&'?'&amp;':character==='<'?'&lt;':character==='>'?'&gt;':character;if(length+safe.length>3800){escaped.push('\\n… Reply shortened. Ask for a narrower contact or task.');break;}escaped.push(safe);length+=safe.length;}
return [{json:{chat_id:authorized.reply_chat_id,text:escaped.join('')}}];
`;

export function configuredGuard(userId: string, chatId: string): string {
  if (!/^[1-9]\d{0,15}$/.test(userId) || !/^[1-9]\d{0,15}$/.test(chatId))
    throw new Error("invalid owner IDs");
  return telegramGuardCode
    .replace("CONFIGURE_OWNER_USER_ID", userId)
    .replace("CONFIGURE_OWNER_CHAT_ID", chatId);
}
export function configuredLiveGuard(
  userId: string,
  chatId: string,
  principalId: string,
  channelId: string,
): string {
  configuredGuard(userId, chatId);
  if (
    !/^[A-Za-z0-9_-]{1,100}$/.test(principalId) ||
    principalId.startsWith("CONFIGURE_") ||
    !/^[a-z0-9-]{1,80}$/.test(channelId)
  )
    throw new Error("invalid live binding");
  return telegramLiveGuardCode
    .replaceAll("CONFIGURE_OWNER_USER_ID", userId)
    .replaceAll("CONFIGURE_OWNER_CHAT_ID", chatId)
    .replaceAll("CONFIGURE_LIVE_PRINCIPAL_ID", principalId)
    .replaceAll("CONFIGURE_LIVE_CHANNEL_ID", channelId);
}
export const telegramLiveReplyCode = telegramReplyCode
  .replace(
    "['Course demo • fictional data']",
    "['Private Gmail and Calendar summary']",
  )
  .replace(
    "Commands: /status, /today, /prep F17,",
    "Commands: /status, /today, /contacts query, /prep email-or-ID,",
  )
  .replace(
    "Your private control chat uses fictional evidence only. No personal inbox history is imported.",
    "Approved scope: recent Gmail and selected upcoming calendars. Replies stay in your enrolled private control chat; no contact receives an action.",
  )
  .replace(
    "const lines =",
    `const localDate = value => {const date=new Date(value);if(!Number.isFinite(date.getTime()))return 'unknown date';const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Paris',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);const get=t=>p.find(x=>x.type===t).value;return get('year')+'-'+get('month')+'-'+get('day');};
const localTime=value=>{const date=new Date(value);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Paris',dateStyle:'medium',timeStyle:'short'}).format(date)+' Europe/Paris':'unknown time';};
const lines =`,
  )
  .replace("Fixture clock:", "Clock:")
  .replace(
    "string(item.occurred_at) + ': ' + string(item.body_text)",
    "(item.all_day ? 'All-day '+localDate(item.occurred_at)+' (end-exclusive '+localDate(item.end_at)+')' : localTime(item.occurred_at)+(item.end_at?' to '+localTime(item.end_at):'')) + ': ' + string(item.body_text) + (item.evidence_reference?' ['+string(item.evidence_reference)+']':'')",
  )
  .replace(
    " if(record(reply.contact))",
    " if(typeof reply.unavailable_record_count==='number')lines.push('Unavailable source records needing review: '+reply.unavailable_record_count+'.');\n if(record(reply.contact))",
  )
  .replace("Upcoming fixture meetings:", "Upcoming meetings:")
  .replace(
    "None in the fixture window.",
    "None in the imported window; check coverage before inferring absence.",
  )
  .replace(
    " if(record(reply.contact))",
    " if(Array.isArray(reply.contacts)){lines.push('Contacts ('+reply.contacts.length+' of '+reply.contacts_total+' matches):');for(const c of reply.contacts.filter(record))lines.push(string(c.name)+' ('+string(c.contact_id)+') '+(Array.isArray(c.emails)?c.emails.map(string).join(', '):''));if(typeof reply.lookup_note==='string')lines.push(reply.lookup_note);}\n if(record(reply.contact))",
  )
  .replace(
    "string(source.mode) + '.'",
    "string(source.mode) + '. Last success: '+string(source.last_success)+'. Window: '+string(source.coverage_start)+' to '+string(source.coverage_end)",
  );
