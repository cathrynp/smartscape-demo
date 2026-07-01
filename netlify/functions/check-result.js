const { connectLambda, getStore } = require('@netlify/blobs');

exports.handler = async function(event) {
  connectLambda(event);
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,OPTIONS' }, body: '' };
  }

  const jobId = event.queryStringParameters && event.queryStringParameters.jobId;
  if (!jobId) {
    return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ status: 'error', message: 'Missing jobId' }) };
  }

  try {
    const store = getStore({ name: 'greenprint-jobs', consistency: 'strong' });
    const result = await store.get(jobId, { type: 'json' });

    if (!result) {
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'pending' }) };
    }

    // Clean up once retrieved so storage doesn't grow unbounded
    if (result.status === 'done' || result.status === 'error') {
      store.delete(jobId).catch(function(e) { console.log('Cleanup failed:', e.message); });
    }

    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ status: 'error', message: err.message }) };
  }
};
