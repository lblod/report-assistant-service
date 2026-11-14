// A scripted LLM provider for the tests: replaces fetch, hands out the
// replies in order and keeps what the service sent.
//
//   const requests = scriptLlm([completion('true'), { status: 429, body: {} }]);
//
// A reply is { status, body, headers }, a completion body, an Error to throw
// (a network failure) or a function (url, init) => Response | Promise.
export function scriptLlm(replies) {
  const queue = [...replies];
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers, signal: init.signal });
    if (!queue.length) throw new Error(`the test scripted no reply for LLM call ${requests.length}`);
    const reply = queue.shift();
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'function') return reply(url, init);
    const { status = 200, body = reply, headers = {} } = reply.status ? reply : {};
    return new Response(JSON.stringify(body), { status, headers });
  };
  return requests;
}

// The body of a chat completion with this message content. content is a
// string, null or a list of parts; extra goes on the message (tool_calls).
export function completion(content, extra = {}, finishReason = 'stop') {
  return { choices: [{ index: 0, message: { role: 'assistant', content, ...extra }, finish_reason: finishReason }] };
}

// The content of a Mistral reasoning model: its thinking, then its answer.
export function chunks(thinking, text) {
  return [
    { type: 'thinking', thinking: [{ type: 'text', text: thinking }] },
    { type: 'text', text },
  ];
}
