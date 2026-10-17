// netlify/functions/generate-background.js  (DEMO app)
// The demo writes ONLY the 2 plants it shows plus one "TOTAL PLANTS: N" line (the AI's own
// zip-specific count for a full Greenprint). It never writes the full list or the timeline.
// Haiku writes -> structure check (Sonnet rewrite only if broken) -> free code fixes ->
// Sonnet reviewer returns replacement entries only for flagged plants, swapped in by code.

const { connectLambda, getStore } = require('@netlify/blobs');

const WRITER = 'claude-haiku-4-5-20251001';
const STRONG = 'claude-sonnet-4-6';
const PROMPT_SENTINEL = 'You are SmartScape, an expert in native plants and climate-resilient landscaping';
const SHOWN = 2;

const CODE_FIXES = [
  [/Scrub Live Oak(\s*\(Quercus geminata\))/gi, 'Sand Live Oak$1'],
  [/(Coastalplain Honeycombhead\s*\()Balduina uniflora(\))/gi, '$1Balduina angustifolia$2'],
  [/\b(?:the\s+)?(?:official\s+)?state wildflower\b/gi, 'a native wildflower']
];

const KNOWN_MISTAKES = [
  'Quercus geminata is Sand Live Oak (not "Scrub Live Oak"); Quercus inopina is Scrub Oak.',
  'Coastalplain Honeycombhead is Balduina angustifolia. Balduina uniflora is Oneflower Honeycombhead (flatwoods/bog plant).',
  'Wetland / wet-site plants (for example Scarlet Rosemallow, Pond Apple, Coreopsis floridana) do not fit when Water savings is a goal or the site is dry/sandy.',
  'Milkweed must be a species native to the zip code\'s ecoregion (never tropical milkweed, Asclepias curassavica).',
  'State-listed endangered or threatened plants need a short note that they are state-listed and should only be bought as nursery-propagated stock.',
  'Never call any plant "the state wildflower".'
];

function validateRequest(incoming) {
  if (!incoming || typeof incoming.jobId !== 'string' || !/^job_[0-9]+_[a-z0-9]{3,30}$/.test(incoming.jobId)) return 'Bad job id';
  const m = incoming.messages;
  if (!Array.isArray(m) || m.length !== 1 || !m[0] || m[0].role !== 'user') return 'Bad request';
  const c = m[0].content;
  let promptText = '', images = 0, imgLen = 0;
  if (typeof c === 'string') promptText = c;
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (b && b.type === 'text' && typeof b.text === 'string') promptText += b.text;
      else if (b && b.type === 'image' && b.source && b.source.type === 'base64' && typeof b.source.data === 'string') {
        images++; imgLen += b.source.data.length;
        if (!/^image\/(jpeg|png|webp|gif)$/.test(b.source.media_type || '')) return 'Bad image';
      } else return 'Bad request';
    }
  } else return 'Bad request';
  if (images > 1 || imgLen > 7000000) return 'Image too large';
  if (promptText.length < 500 || promptText.length > 60000) return 'Bad request';
  if (promptText.indexOf(PROMPT_SENTINEL) === -1) return 'Bad request';
  return null;
}

async function callClaude(apiKey, model, maxTokens, messages) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: model, max_tokens: maxTokens, messages: messages })
      });
      const raw = await resp.text();
      if (resp.status === 200) {
        const parsed = JSON.parse(raw);
        return {
          text: (parsed.content && parsed.content[0] && parsed.content[0].text) || '',
          truncated: parsed.stop_reason === 'max_tokens',
          usage: parsed.usage || {}
        };
      }
      lastErr = new Error('Anthropic ' + resp.status + ': ' + raw.slice(0, 200));
      if (resp.status < 500 && resp.status !== 429) break;
    } catch (e) { lastErr = e; }
    await new Promise(function (r) { setTimeout(r, 2000 * (attempt + 1)); });
  }
  throw lastErr || new Error('Anthropic call failed');
}

function plantLines(t) {
  const m = t.match(/RECOMMENDED NATIVE PLANTS:\n([\s\S]*?)(?=TOTAL PLANTS:|PLANTING TIMELINE:|$)/);
  if (!m) return [];
  return m[1].split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l.startsWith('-'); });
}
function totalPlantsLine(t) {
  const m = t.match(/TOTAL PLANTS:\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
function structureProblem(t, truncated) {
  if (truncated) return 'Your previous response above was cut off before it finished.';
  const lines = plantLines(t);
  if (lines.length < 1) return 'Your RECOMMENDED NATIVE PLANTS section above did not include any actual plant lines.';
  if (lines.length > SHOWN) return 'Your RECOMMENDED NATIVE PLANTS section above lists ' + lines.length + ' plants; write exactly ' + SHOWN + '.';
  const bad = lines.filter(function (l) { return l.indexOf('Attracts:') === -1 || !/Lifecycle:\s*(Perennial|Annual|Biennial)/i.test(l); }).length;
  if (bad) return bad + ' plant line(s) above are missing the required trailing "Attracts: [...]" tag and/or the final "Lifecycle: [Perennial/Annual/Biennial]." tag.';
  const n = totalPlantsLine(t);
  if (n === null || n < 5 || n > 12 || n < lines.length) return 'Your response above is missing the final line "TOTAL PLANTS: [number]" (a whole number from 5 to 12).';
  return null;
}
function applyCodeFixes(t) {
  let out = t;
  for (const f of CODE_FIXES) out = out.replace(f[0], f[1]);
  // Quercus geminata is Sand Live Oak everywhere it is mentioned (plant line and timeline)
  if (/Quercus geminata/.test(out)) out = out.replace(/Scrub Live Oak/g, 'Sand Live Oak');
  return out;
}
function parseJson(s) {
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b === -1) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

function reviewPrompt(siteDetails, lines) {
  return 'You are a strict native-plant fact checker for a landscaping app. Check the plants below against the site details. Flag anything you have good reason to doubt, and fix it. A wrong or doubtful plant is worse than a replaced plant, so when unsure whether a plant is truly native to this specific area, replace it with one you are sure of. Do not rewrite for style.\n\n' +
    'SITE DETAILS:\n' + siteDetails + '\n\n' +
    'CHECK EVERY PLANT FOR:\n' +
    '1. NAME: the scientific name truly belongs to the common name given, and the common name is the standard one.\n' +
    '2. NATIVE RANGE: native to the specific county/ecoregion of this zip code, not merely somewhere in the state (plants native only to another part of the state must be replaced).\n' +
    '3. HABITAT: light, soil, drainage and moisture needs fit the site and sun selected; moisture-loving, shade-loving or wetland plants do not fit a dry sunny site or a Water savings goal.\n' +
    '4. LIFECYCLE: the Lifecycle tag is correct (annual vs perennial vs biennial).\n' +
    '5. LAYER: the plant sits under the right LAYER line for its real height and form (herbaceous wildflowers are not Shrubs & Bushes; Groundcover only if under about 1 foot).\n' +
    '6. CLAIMS: size, wildlife and insect statements are well documented; delete or fix unverified claims (for example about ladybugs or parasitic wasps); milkweed must be locally native.\n' +
    '7. State-listed endangered or threatened plants carry a short sourcing note (buy only nursery-propagated stock).\n' +
    '8. Tree size fits the yard size.\n\n' +
    'KNOWN MISTAKES TO CATCH:\n- ' + KNOWN_MISTAKES.join('\n- ') + '\n\n' +
    'PLANTS (numbered):\n' + lines.map(function (l, i) { return (i + 1) + '. ' + l; }).join('\n') + '\n\n' +
    'Reply with ONLY a JSON object: {"notes":"<one short sentence per problem found, or \\"none\\">","plant_fixes":[{"n":<plant number>,"layer":"<only if the layer is wrong>","new_line":"<complete corrected plant line starting with \\"- \\", in the EXACT same format and similar length as the original, ending with its Attracts: and Lifecycle: tags>"}]}. If a plant does not fit the site or area, replace it with a different plant native to this specific area that fits the site (not already listed) written in the same format. If a plant is under the wrong layer but is otherwise fine, keep the line as it is and add "layer":"<Groundcover | Wildflowers & Grasses | Shrubs & Bushes | Canopy/Trees>" to that fix entry (new_line may then be the unchanged line). If nothing needs fixing return {"notes":"none","plant_fixes":[]}.';
}

const LAYERS = ['Groundcover', 'Wildflowers & Grasses', 'Shrubs & Bushes', 'Canopy/Trees'];

// Re-label the LAYER heading above a plant line, only when that plant is alone in its group.
function relabelLayer(out, line, layer) {
  const idx = out.indexOf(line);
  if (idx === -1) return out;
  const before = out.slice(0, idx);
  const hm = before.lastIndexOf('LAYER:');
  if (hm === -1) return out;
  const hEnd = out.indexOf('\n', hm);
  const nextLayer = out.indexOf('LAYER:', idx);
  const groupEnd = nextLayer === -1 ? out.length : nextLayer;
  const groupLines = out.slice(hEnd, groupEnd).split('\n').filter(function (l) { return l.trim().startsWith('-'); });
  if (groupLines.length !== 1) return out;
  return out.slice(0, hm) + 'LAYER: ' + layer + out.slice(hEnd);
}

async function review(apiKey, text, siteDetails) {
  const lines = plantLines(text);
  if (!lines.length) return { text: text, changed: 0, usage: [], ran: false };
  const usage = [];
  let lastNotes = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await callClaude(apiKey, STRONG, 2500, [{ role: 'user', content: reviewPrompt(siteDetails, lines) }]);
      usage.push(r.usage);
      const rv = parseJson(r.text);
      if (!rv) { lastNotes = 'unparseable reply'; continue; }
      let out = text, changed = 0;
      const fixes = Array.isArray(rv.plant_fixes) ? rv.plant_fixes : [];
      fixes.forEach(function (f) {
        const n = parseInt(f && f.n, 10);
        if (!(n >= 1 && n <= lines.length)) return;
        const nl = f && typeof f.new_line === 'string' ? f.new_line.trim() : '';
        const orig = lines[n - 1];
        let cur = orig;
        if (nl && nl !== orig && nl.indexOf('\n') === -1 && nl.length <= 1800 && nl.length >= 80 && nl.startsWith('- ') &&
            /\([^)]+\)/.test(nl) && nl.indexOf('Attracts:') !== -1 && /Lifecycle:\s*(Perennial|Annual|Biennial)/i.test(nl) && out.indexOf(orig) !== -1) {
          out = out.replace(orig, function () { return nl; });
          lines[n - 1] = nl; cur = nl; changed++;
        }
        if (f && typeof f.layer === 'string' && LAYERS.indexOf(f.layer) !== -1) {
          const relabeled = relabelLayer(out, cur, f.layer);
          if (relabeled !== out) { out = relabeled; changed++; }
        }
      });
      const notes = String(rv.notes || '').slice(0, 1200);
      if (changed && structureProblem(out, false)) return { text: text, changed: 0, usage: usage, ran: true, notes: notes, proposed: fixes.length, discarded: true };
      return { text: out, changed: changed, usage: usage, ran: true, notes: notes, proposed: fixes.length };
    } catch (e) { console.log('Reviewer attempt ' + (attempt + 1) + ' failed: ' + e.message); lastNotes = 'error: ' + e.message.slice(0, 100); }
  }
  return { text: text, changed: 0, usage: usage, ran: true, notes: lastNotes || 'reviewer failed', proposed: 0, failed: true };
}

exports.handler = async function (event) {
  connectLambda(event);
  let jobId;
  try {
    const incoming = JSON.parse(event.body);
    const bad = validateRequest(incoming);
    jobId = incoming && typeof incoming.jobId === 'string' && /^job_[0-9]+_[a-z0-9]{3,30}$/.test(incoming.jobId) ? incoming.jobId : null;
    if (bad || !jobId) { console.log('Rejected request: ' + bad); return { statusCode: 202, body: '' }; }

    const store = getStore({ name: 'greenprint-jobs' });
    const API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!API_KEY) { await store.setJSON(jobId, { status: 'error', message: 'API key not configured' }); return { statusCode: 202, body: '' }; }

    const messages = incoming.messages;
    const promptText = typeof messages[0].content === 'string' ? messages[0].content : messages[0].content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n');
    const sd = promptText.match(/Site details:\n([\s\S]*?)\n\s*If you are not certain/);
    const siteDetails = sd ? sd[1] : promptText.slice(0, 600);

    let w;
    try { w = await callClaude(API_KEY, WRITER, 1800, messages); }
    catch (e) { console.log('Haiku failed, using Sonnet: ' + e.message); w = await callClaude(API_KEY, STRONG, 1800, messages); }
    let text = w.text;
    const usageLog = [{ model: WRITER, u: w.usage }];
    let reviewInfo = { reviewerRan: false };

    if (!/PHOTO_MISMATCH:/.test(text)) {
      const problem = structureProblem(text, w.truncated);
      if (problem) {
        console.log('Demo structure problem: ' + problem + ' — Sonnet retry.');
        try {
          const r = await callClaude(API_KEY, STRONG, 1800, messages.concat([
            { role: 'assistant', content: text },
            { role: 'user', content: problem + ' Provide your complete response again in the exact same format: SITE ANALYSIS, then RECOMMENDED NATIVE PLANTS with exactly ' + SHOWN + ' plants (each ending with its own "Attracts: [...]" and "Lifecycle: [...]." tags), then a final line "TOTAL PLANTS: [number]". No timeline.' }
          ]));
          usageLog.push({ model: STRONG, u: r.usage });
          if (!structureProblem(r.text, r.truncated) || structureProblem(text, w.truncated)) text = r.text;
        } catch (e) { console.log('Sonnet retry failed: ' + e.message); }
      }
      text = applyCodeFixes(text);
      if (!structureProblem(text, false) || plantLines(text).length) {
        const rv = await review(API_KEY, text, siteDetails);
        reviewInfo = { reviewerRan: !!rv.ran, reviewerFailed: !!rv.failed, reviewerProposed: rv.proposed || 0, reviewerApplied: rv.changed, reviewerNotes: rv.notes || '' };
        text = applyCodeFixes(rv.text);
        rv.usage.forEach(function (u) { usageLog.push({ model: STRONG, u: u }); });
      }
    }

    console.log('DEMO USAGE ' + JSON.stringify(usageLog));
    const PRICE = { 'claude-haiku-4-5-20251001': [1, 5], 'claude-sonnet-4-6': [3, 15] };
    let cost = 0;
    usageLog.forEach(function (e) { const p = PRICE[e.model] || [3, 15]; cost += ((e.u && e.u.input_tokens) || 0) * p[0] / 1e6 + ((e.u && e.u.output_tokens) || 0) * p[1] / 1e6; });
    const debug = Object.assign({ cost: Math.round(cost * 10000) / 10000, calls: usageLog.map(function (e) { return e.model.split('-')[1]; }) }, reviewInfo);
    await store.setJSON(jobId, { status: 'done', debug: debug, body: JSON.stringify({ content: [{ type: 'text', text: text }] }) });
  } catch (err) {
    console.log('Error:', err.message);
    if (jobId) {
      try { await getStore({ name: 'greenprint-jobs' }).setJSON(jobId, { status: 'error', message: 'The AI powering Greenprint Generator is very busy right now' }); }
      catch (storeErr) { console.log('Failed to write error to store:', storeErr.message); }
    }
  }
  return { statusCode: 202, body: '' };
};
