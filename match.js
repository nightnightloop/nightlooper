// nightlooper radio — discover mood matcher (AI)
// A Netlify Function: holds your Anthropic API key SERVER-SIDE and asks Claude
// to match a listener's feeling to one of your episodes, in lake's voice.
//
// SETUP (once):
//   1. Put this file at:  netlify/functions/match.js   (exactly this path)
//   2. In Netlify: Site configuration -> Environment variables ->
//        add  ANTHROPIC_API_KEY  =  your key from console.anthropic.com
//   3. Redeploy. That's it. The site calls /.netlify/functions/match automatically.
//
// The front-end falls back to the built-in keyword matcher if this ever fails,
// so discover never breaks — even before you've set this up.

// ----- model (cheap + fast). You can change this string if you prefer another. -----
const MODEL = "claude-3-5-haiku-latest";

// ===== EPISODE GUIDE — edit freely. This is what the AI reasons from. =====
// Keep "loop" names exactly as you want them shown. n = episode number.
const EPISODES = [
  { n: 1, loop: "nice 2 meet u loop",
    about: "the beginning of summer, before anything goes wrong. a new crush, cute texts, waiting for a reply, romanticizing everyday life. yearning, flirtation, hope, butterflies. light and warm — NOT heartbreak.",
    yes: "having a crush, romantic anticipation, wanting to feel hopeful, beginning something, romanticizing life, beach/summer nostalgia, butterflies before a first date, something light and dreamy.",
    no:  "breakup catharsis, grief, anger, closure." },
  { n: 2, loop: "hurtsdunnit loop",
    about: "the grief that comes with growth. outgrowing people, ending a friendship or relationship, choosing yourself even when it hurts, the loneliness of becoming someone new. sit-with-the-sadness, not healing yet. the late train, the replayed conversation.",
    yes: "losing a friendship, grieving someone still alive, outgrowing someone, choosing yourself and still hurting, feeling misunderstood in a transition, missing someone you shouldn't return to, wanting to sit with sadness, replaying old conversations.",
    no:  "light romance, flirtation, party music, motivational cheer, quick reassurance, anger/revenge." },
  { n: 3, loop: "i reminisce loop",
    about: "desire after the moment has passed. old lovers, situationships, the text better left unsent, missing the intimacy more than the relationship. sensual, nocturnal, city lights, driving after midnight. desire tangled with restraint.",
    yes: "wanting to text an ex/former lover but knowing better, thinking about someone after midnight, missing intimacy not the relationship, replaying one charged night, driving through the city thinking of someone, feeling sexy + nostalgic + a little lonely.",
    no:  "pure breakup grief, wholesome new romance, party music, closure, advice to send the text." },
  { n: 4, loop: "dream loop",
    about: "a dreamy crush that won't let you sleep. can't stop thinking about them, replaying a maybe, counting sheep at 4am. sweet on the surface with a restless, sleepless ache underneath.",
    yes: "can't stop thinking about a crush, lying awake over someone, a dreamy 'what if', infatuation that keeps you up, soft obsessive daydreaming.",
    no:  "settled grief, closure, anger." },
  { n: 5, loop: "tender loop",
    about: "gentle and sensitive, a little sad. a moonlight diner, soft goodbyes, being held. otis redding warmth meeting a quiet farewell. tenderness, care, and the ache of too many ways to say goodbye.",
    yes: "wanting comfort, a soft sad night, saying goodbye gently, being tender with yourself or someone, quiet late-night care, bittersweet warmth.",
    no:  "hype, anger, party energy." },
  { n: 6, loop: "lucky loop",
    about: "feeling fortunate, like things might go your way. a koi pond, easy luck, playful hope. lighter and a little charmed.",
    yes: "feeling lucky or hopeful about how things are going, a good-omen mood, playful optimism, wanting something buoyant.",
    no:  "deep grief, heavy heartbreak." },
  { n: 7, loop: "blonde loop",
    about: "an ode to frank ocean's Blonde, ten summers later. bittersweet summer nostalgia, a long drive (white ferrari), memory softened by time. wistful, spacious, golden-hour melancholy.",
    yes: "missing a past summer, blonde/frank ocean feelings, a nostalgic long drive, bittersweet memory, wistful golden-hour longing.",
    no:  "brand-new giddy romance, anger." }
];

function guide(available) {
  const set = new Set(available);
  const lines = EPISODES.map(e => {
    const tag = set.has(e.n) ? "" : "  [COMING SOON — do not recommend]";
    return `ep${e.n} — "${e.loop}"${tag}\n  vibe: ${e.about}\n  recommend when: ${e.yes}\n  avoid when: ${e.no}`;
  });
  return lines.join("\n\n");
}

const SYSTEM = (available) => `You are the matchmaker for "nightlooper radio," a late-night DJ-mix show by lake.
A listener types how they feel. Match them to the single best episode "loop" — or two if the feeling genuinely splits between them.

You may ONLY recommend from episodes that are available. Never recommend a COMING SOON episode.

Write in lake's voice: all lowercase, warm, spare, a little poetic, no emojis, no exclamation. Never say "you should" or give advice. Never tell someone to send a text.

Episodes:
${guide(available)}

Reply with ONLY a JSON object, nothing else, in one of these shapes:

A real match (1 or 2 loops):
{"kind":"match","loops":[{"n":<episode number>,"loop":"<exact loop name>","line":"<one short lowercase line, in lake's voice, on why this fits — evocative, not a summary>"}]}

The feeling is one broad word that fits every episode (e.g. just "yearning", "love", "music"):
{"kind":"universal","word":"<the word>","line":"<one lowercase line asking them to narrow it down>"}

Too vague or empty to match (one or two throwaway words with no scene, e.g. "idk", "hi"):
{"kind":"vague","line":"<one lowercase line asking for the scene>"}

A real, specific feeling that genuinely fits none of the available loops:
{"kind":"nomatch","line":"<one lowercase line admitting there's no loop for that yet>"}

Rules: prefer ONE loop; only return two when the feeling truly lives between them. Respect each episode's "avoid when". Keep every "line" short (max ~16 words). Output JSON only.`;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "method" }) };
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { statusCode: 500, body: JSON.stringify({ error: "no key" }) };

  let feeling = "", available = [];
  try {
    const b = JSON.parse(event.body || "{}");
    feeling = String(b.feeling || "").slice(0, 500);
    available = Array.isArray(b.available) ? b.available.filter(n => Number.isFinite(n)) : [];
  } catch (_) {
    return { statusCode: 400, body: JSON.stringify({ error: "bad body" }) };
  }
  if (!feeling.trim()) return { statusCode: 400, body: JSON.stringify({ error: "empty" }) };
  if (!available.length) available = EPISODES.map(e => e.n); // safety default

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: SYSTEM(available),
        messages: [{ role: "user", content: feeling }]
      })
    });
    if (!res.ok) {
      const t = await res.text();
      return { statusCode: 502, body: JSON.stringify({ error: "upstream", detail: t.slice(0, 200) }) };
    }
    const data = await res.json();
    let text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
    // strip any stray code fences, then pull the JSON object
    text = text.replace(/```json|```/g, "").trim();
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s < 0 || e < 0) throw new Error("no json");
    const out = JSON.parse(text.slice(s, e + 1));

    // sanity: only keep available loops on a match
    if (out.kind === "match" && Array.isArray(out.loops)) {
      out.loops = out.loops.filter(l => available.includes(l.n)).slice(0, 2);
      if (!out.loops.length) return { statusCode: 200, body: JSON.stringify({ kind: "nomatch", line: "none of these are quite it yet." }) };
    }
    return {
      statusCode: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify(out)
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: "fail", detail: String(err).slice(0, 200) }) };
  }
};
