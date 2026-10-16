// Retired: the demo page does not use license keys. Verification now lives only in the paid app.
exports.handler = async function () {
  return { statusCode: 410, body: JSON.stringify({ valid: false, error: 'This endpoint has been retired.' }) };
};
