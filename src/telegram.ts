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
const help = text === '/start' || text === '/help' || !/^\\/(?:status|today|prep|draft|confirm|done|cancel|outreach|approve|edit|skip)(?:\\s|$)/.test(text);
return [{json:{reply_chat_id:allowedChatId,help,telegram_update_id:update.update_id,telegram_channel_id:'tend-course-control',command:{owner_id:'demo-owner',user_id:'demo-user',chat_id:'demo-private',chat_type:'private',text:help?'/status':text}}}];
`;
export const telegramLiveGuardCode = telegramGuardCode
  .replace("if (!text.startsWith('/')) return [];", "if (!text) return [];")
  .replace("const help =", "const help = text.startsWith('/') && (")
  .replace(".test(text);", ".test(text));")
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
if(authorized.help) lines.push('Commands: /status, /today, /prep F17, /confirm ID YYYY-MM-DD, /draft ID, /done ID, /cancel ID, /outreach, /approve ID CODE, /edit ID text, /skip ID.','Your private control chat uses fictional evidence only. No personal inbox history is imported.');
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
 if(Array.isArray(reply.outreach)){lines.push('Outreach drafts. Nothing goes out until you approve; email becomes a Gmail draft you send yourself.');if(!reply.outreach.length)lines.push('None waiting.');for(const item of reply.outreach.filter(record))lines.push(string(item.id)+' code '+string(item.text_code)+' ['+string(item.status)+'] '+string(item.contact_name)+' via '+string(item.channel)+': '+string(item.draft_text));}
 if(typeof reply.outreach_error==='string')lines.push('Outreach refused: '+reply.outreach_error);
 if(record(reply.outreach_item)){const o=reply.outreach_item;lines.push(string(o.id)+': '+string(o.status)+'.'+(typeof o.text_code==='string'?' Code '+o.text_code+'.':''),string(o.draft_text));if(typeof o.deep_link==='string')lines.push('Copy and send it yourself: '+o.deep_link);}
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
  .replace("['Course demo • fictional data']", "['Tend • private assistant']")
  .replace(
    "Commands: /status, /today, /prep F17,",
    "Commands: /status, /today, /contacts query, /prep email-or-ID,",
  )
  .replace(
    "Your private control chat uses fictional evidence only. No personal inbox history is imported.",
    "You can also ask normal messages about imported source status, meetings, promises, contact briefings, held drafts, conversation search and priority briefings. Approved source coverage may be partial. Replies stay in your enrolled private control chat; no contact receives an action.",
  )
  .replace(
    "const lines =",
    `const localDate = value => {const date=new Date(value);if(!Number.isFinite(date.getTime()))return 'unknown date';const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Paris',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);const get=t=>p.find(x=>x.type===t).value;return get('year')+'-'+get('month')+'-'+get('day');};
const localTime=value=>{const date=new Date(value);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Paris',dateStyle:'medium',timeStyle:'short'}).format(date)+' Europe/Paris':'unknown time';};
const lines =`,
  )
  .replace("Fixture clock:", "Clock:")
  .replace(
    " if(record(reply.counts))",
    " if(typeof reply.normal_message==='string'){if(!(record(reply.ai)&&record(reply.ai.draft)&&reply.normal_message===reply.ai.draft.label))lines.push(reply.normal_message);if(record(reply.ai)&&record(reply.ai.draft)){const d=reply.ai.draft;lines.push(string(d.label)+'. Nothing sent to a contact.',record(d.recipient)?'For: '+string(d.recipient.name):'',string(d.text),d.style_basis==='recipient_examples'?'Writing style: your messages to this contact.':'Writing style: neutral.');}else if(typeof reply.preview==='string')lines.push('Private draft preview only. Nothing sent to a contact.',reply.preview);if(Array.isArray(reply.commitments)&&Array.isArray(reply.pending))lines.push('Confirmed obligations: '+reply.commitments.length+'. Pending proposals: '+reply.pending.length+'.');}\n if(record(reply.counts))",
  )
  .replace(
    "string(item.occurred_at) + ': ' + string(item.body_text)",
    "(item.all_day ? 'All-day '+localDate(item.occurred_at)+' (end-exclusive '+localDate(item.end_at)+')' : localTime(item.occurred_at)+(item.end_at?' to '+localTime(item.end_at):'')) + ': ' + string(item.body_text) + (item.evidence_reference?' ['+string(item.evidence_reference)+']':'')",
  )
  .replace(
    " if(record(reply.contact))",
    " if(typeof reply.unavailable_record_count==='number')lines.push('Unavailable source records needing review: '+reply.unavailable_record_count+'.');\n if(typeof reply.extraction_review_count==='number')lines.push('Unvalidated extraction attempts needing review: '+reply.extraction_review_count+'.');\n if(typeof reply.unverified_commitment_count==='number')lines.push('Promises with unavailable evidence: '+reply.unverified_commitment_count+'. Reverified proposals require your confirmation.');\n if(record(reply.contact))",
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
    "if(Array.isArray(reply.sources) || Array.isArray(reply.coverage))",
    "if((Array.isArray(reply.sources) || Array.isArray(reply.coverage)) && (record(reply.counts) || typeof reply.normal_message!=='string'))",
  )
  .replace(
    " if(typeof reply.preview === 'string')",
    " if(typeof reply.normal_message!=='string' && typeof reply.preview === 'string')",
  )
  .replace(
    " if(Array.isArray(reply.evidence))",
    ` if(typeof reply.priority_unavailable_count==='number'&&reply.priority_unavailable_count>0)lines.push(reply.priority_unavailable_count+' obligations/proposals have no eligible current evidence; review source status.');
 if(typeof reply.search_note==='string')lines.push(reply.search_note);
 if(Array.isArray(reply.search_results)){
   const results=reply.search_results.filter(record);const shown=[];
   const safeLength=value=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').length;
   let budget=Math.max(0,2700-safeLength(lines.join('\\n')));
   for(const item of results){
     const raw=string(item.text).replace(/\\s+/g,' ').trim();const excerpt=Array.from(raw).slice(0,140).join('')+(Array.from(raw).length>140?'…':'');
     const line=localTime(item.date)+' ['+string(item.source)+', '+string(item.attribution)+'] '+excerpt+' ['+string(item.reference)+']';
     if(safeLength(line)+1>budget)break;shown.push(line);budget-=safeLength(line)+1;
   }
   lines.push('Search: '+shown.length+' of '+results.length+' ranked matches shown (up to 10 returned; imported coverage may be partial).',...shown);
   if(shown.length<results.length)lines.push('Narrow your search to see the remaining matches.');
 }
 if(Array.isArray(reply.priorities)){lines.push('Priority review:');if(!reply.priorities.length)lines.push('No eligible priorities in the imported window; review unavailable-evidence warnings.');for(const item of reply.priorities.filter(record)){const date=item.all_day?'All-day '+localDate(item.date)+(item.end_at?' (end-exclusive '+localDate(item.end_at)+')':''):/^\\d{4}-\\d{2}-\\d{2}$/.test(string(item.date))?string(item.date):localTime(item.date);lines.push(string(item.kind)+': '+string(item.reason)+' '+date+' '+string(item.text)+' ['+string(item.source)+': '+string(item.reference)+']');}}
 if(Array.isArray(reply.priority_pending)){lines.push('Unconfirmed proposals (not deadlines): '+reply.priority_pending.length+' shown of '+reply.pending_total+'.');for(const item of reply.priority_pending.filter(record))lines.push(string(item.text)+' ['+string(item.source)+': '+string(item.reference)+']');}
 if(Array.isArray(reply.evidence))`,
  )
  .replace(
    "let text = lines.join",
    `if(typeof reply.normal_message==='string'&&!record(reply.counts)&&(Array.isArray(reply.sources)||Array.isArray(reply.coverage))){const c=Array.isArray(reply.sources)?reply.sources:reply.coverage;lines.push('Coverage: '+c.filter(record).map(s=>string(s.source)+': '+string(s.status)+' ('+string(s.mode)+')').join('; ')+'. Ask for source status for full windows.');}
let text = lines.join`,
  )
  .replace(
    "string(source.mode) + '.'",
    "string(source.mode) + '. Last success: '+string(source.last_success)+'. Window: '+string(source.coverage_start)+' to '+string(source.coverage_end)",
  );
