// Retired: the demo page uses generate-background.js. This old open endpoint is switched off.
exports.handler = async function () {
  return { statusCode: 410, body: JSON.stringify({ error: 'This endpoint has been retired.' }) };
};
