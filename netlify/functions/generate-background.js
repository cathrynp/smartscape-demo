const { connectLambda, getStore } = require('@netlify/blobs');

exports.handler = async function(event) {
  connectLambda(event);
  let jobId;
  try {
    const incoming = JSON.parse(event.body);
    jobId = incoming.jobId;
    const store = getStore({ name: 'greenprint-jobs' });
    const API_KEY = process.env.ANTHROPIC_API_KEY;

    if (!API_KEY) {
      await store.setJSON(jobId, { status: 'error', message: 'API key not configured' });
      return { statusCode: 202, body: '' };
    }

    function extractAssistantText(rawResponseText) {
      try {
        const parsed = JSON.parse(rawResponseText);
        return (parsed.content && parsed.content[0] && parsed.content[0].text) || '';
      } catch (e) {
        return '';
      }
    }

    function wasTruncated(rawResponseText) {
      try {
        const parsed = JSON.parse(rawResponseText);
        return parsed.stop_reason === 'max_tokens';
      } catch (e) {
        return false;
      }
    }

    // Checks whether the RECOMMENDED NATIVE PLANTS section actually contains
    // at least one parseable plant line ("- Common Name (Scientific name) ...").
    // A response can have every section header present and still fail here if
    // the model didn't fill in real plant lines underneath.
    function hasPlants(assistantText) {
      const rpMatch = assistantText.match(/RECOMMENDED NATIVE PLANTS:\n([\s\S]*?)(?=PLANTING TIMELINE:|$)/);
      if (!rpMatch) return false;
      const lines = rpMatch[1].split('\n').map(function(l) { return l.trim(); });
      return lines.some(function(l) { return l.startsWith('-'); });
    }

    async function callClaude(model, maxTokens, messages) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({ model: model, max_tokens: maxTokens, messages: messages })
      });
      return await response.text();
    }

    // First attempt: fast, low-cost Haiku model.
    let text = await callClaude('claude-haiku-4-5-20251001', 3500, incoming.messages);
    console.log('Haiku attempt response:', text.substring(0, 300));

    const assistantText = extractAssistantText(text);
    const truncated = wasTruncated(text);
    const missingPlants = !hasPlants(assistantText);

    if (truncated || missingPlants) {
      const reason = truncated
        ? 'Your previous response above was cut off before it finished.'
        : 'Your RECOMMENDED NATIVE PLANTS section above did not include any actual plant lines.';
      console.log((truncated ? 'Truncated' : 'Missing plants') + ' on Haiku attempt — retrying once with Sonnet.');
      const retryMessages = incoming.messages.concat([
        { role: 'assistant', content: assistantText },
        { role: 'user', content: reason + ' Provide your complete full response again in the exact same format, making sure the RECOMMENDED NATIVE PLANTS section lists 8-12 real plants grouped under LAYER headers as instructed.' }
      ]);
      // Retry attempt: fall back to Sonnet for reliability.
      const retryText = await callClaude('claude-sonnet-4-6', 3500, retryMessages);
      console.log('Sonnet retry response:', retryText.substring(0, 300));
      const retryAssistantText = extractAssistantText(retryText);
      if (!wasTruncated(retryText) && hasPlants(retryAssistantText)) {
        text = retryText;
      } else {
        console.log('Sonnet retry still incomplete; keeping original Haiku response.');
      }
    }

    await store.setJSON(jobId, { status: 'done', body: text });
  } catch (err) {
    console.log('Error:', err.message);
    if (jobId) {
      try {
        const store = getStore({ name: 'greenprint-jobs' });
        await store.setJSON(jobId, { status: 'error', message: err.message });
      } catch (storeErr) {
        console.log('Failed to write error to store:', storeErr.message);
      }
    }
  }
  return { statusCode: 202, body: '' };
};
