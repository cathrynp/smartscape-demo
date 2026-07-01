const { connectLambda, getStore } = require('@netlify/blobs');

exports.handler = async function(event) {
  connectLambda(event);
  let jobId;
  try {
    const incoming = JSON.parse(event.body);
    jobId = incoming.jobId;
    const store = getStore({ name: 'greenprint-jobs', consistency: 'strong' });
    const API_KEY = process.env.ANTHROPIC_API_KEY;

    if (!API_KEY) {
      await store.setJSON(jobId, { status: 'error', message: 'API key not configured' });
      return { statusCode: 202, body: '' };
    }

    const requestBody = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: incoming.messages
    };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(requestBody)
    });

    const text = await response.text();
    console.log('Anthropic status:', response.status, 'response:', text.substring(0, 300));
    await store.setJSON(jobId, { status: 'done', body: text });
  } catch (err) {
    console.log('Error:', err.message);
    if (jobId) {
      try {
        const store = getStore({ name: 'greenprint-jobs', consistency: 'strong' });
        await store.setJSON(jobId, { status: 'error', message: err.message });
      } catch (storeErr) {
        console.log('Failed to write error to store:', storeErr.message);
      }
    }
  }
  return { statusCode: 202, body: '' };
};
