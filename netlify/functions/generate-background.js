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

    function plantLines(assistantText) {
      const rpMatch = assistantText.match(/RECOMMENDED NATIVE PLANTS:\n([\s\S]*?)(?=PLANTING TIMELINE:|$)/);
      if (!rpMatch) return [];
      return rpMatch[1].split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.startsWith('-'); });
    }

    // Attracts tags are unconditionally required by the prompt on every plant line.
    function countMissingAttracts(assistantText) {
      return plantLines(assistantText).filter(function(l) { return l.indexOf('Attracts:') === -1; }).length;
    }

    // Indigenous use notes are legitimately optional per-plant (the prompt says to
    // omit when a use isn't well documented), so we don't require every line to
    // have one — but if NONE of the plants got a note, that's a systemic miss
    // worth a retry rather than a genuine case of "no documented uses at all."
    function hasNoIndigenousNotes(assistantText) {
      const lines = plantLines(assistantText);
      if (lines.length === 0) return false;
      return !lines.some(function(l) { return /indigenous/i.test(l); });
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
    const missingAttracts = missingPlants ? 0 : countMissingAttracts(assistantText);
    const noIndigenous = missingPlants ? false : hasNoIndigenousNotes(assistantText);

    if (truncated || missingPlants || missingAttracts > 0 || noIndigenous) {
      let reason;
      if (truncated) {
        reason = 'Your previous response above was cut off before it finished.';
      } else if (missingPlants) {
        reason = 'Your RECOMMENDED NATIVE PLANTS section above did not include any actual plant lines.';
      } else if (missingAttracts > 0) {
        reason = missingAttracts + ' plant line(s) above are missing the required trailing "Attracts: [...]" tag naming the specific pollinators, birds, or wildlife that plant supports.';
      } else {
        reason = 'None of the plant lines above included an Indigenous use note, which is unlikely across a full list of 8-12 native species — re-check each plant for a documented Indigenous use (food, medicine, fiber, dye, or utilitarian) and include it where genuinely documented.';
      }
      console.log('Retrying with Sonnet — reason: ' + reason);
      const retryMessages = incoming.messages.concat([
        { role: 'assistant', content: assistantText },
        { role: 'user', content: reason + ' Provide your complete full response again in the exact same format, making sure the RECOMMENDED NATIVE PLANTS section lists 8-12 real plants grouped under LAYER headers as instructed, every plant line ends with its own "Attracts: [...]" tag, and each plant includes its documented Indigenous use note where one genuinely exists.' }
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
