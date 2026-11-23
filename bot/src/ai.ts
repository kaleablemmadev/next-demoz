// src/ai.ts
// Gemini connection for the bot. Every feature must work without it: askJson returns null when the key is
// missing, the daily limit is reached, or the call fails. Callers then fall back to the normal forms.
//
// Settings (Render environment variables):
//   GEMINI_API_KEY   required to switch the AI on
//   GEMINI_MODEL     optional, a model name the key can use; otherwise the bot picks one from the key's list
//   AI_DAILY_LIMIT   optional, requests per person per day, defaults to 30

const API_KEY = process.env.GEMINI_API_KEY?.trim() || '';
const DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT) || 30;
const TIMEOUT_MS = 15_000;

export function aiEnabled(): boolean {
    return API_KEY.length > 0;
}

// Per-person daily counter. In memory: it resets when the bot restarts, which is acceptable for a limit.
const usage = new Map<string, { day: string; count: number }>();

function today(): string {
    return new Date().toISOString().slice(0, 10);
}

export function withinDailyLimit(userKey: string): boolean {
    const entry = usage.get(userKey);
    const day = today();
    if (!entry || entry.day !== day) {
        usage.set(userKey, { day, count: 0 });
        return true;
    }
    return entry.count < DAILY_LIMIT;
}

function countUse(userKey: string) {
    const entry = usage.get(userKey);
    if (entry && entry.day === today()) entry.count++;
}

// Removes contact details before text leaves the bot: @handles, emails, phone numbers and links.
export function redact(text: string): string {
    return text
        .replace(/https?:\/\/\S+/gi, '[link]')
        .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[email]')
        .replace(/@[A-Za-z0-9_]{3,}/g, '[handle]')
        .replace(/(\+?\d[\d\s-]{7,}\d)/g, '[phone]');
}

// The model is looked up once from Gemini's list for this key, so a retired or renamed model does not break the bot.
let modelCache: Promise<string | null> | null = null;

async function chooseModel(): Promise<string | null> {
    const wanted = process.env.GEMINI_MODEL?.trim();
    try {
        const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
            headers: { 'x-goog-api-key': API_KEY },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) {
            console.error(`Gemini model list returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
            return null;
        }
        const body = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
        const usable = (body.models ?? [])
            .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
            .map((m) => m.name.replace(/^models\//, ''));
        if (usable.length === 0) {
            console.error('This Gemini key has no models that support generateContent');
            return null;
        }
        if (wanted && usable.includes(wanted)) return wanted;
        // Prefer stable flash models (highest version first), then any flash model, then anything usable.
        const stableFlash = usable.filter((m) => /^gemini-[\d.]+-flash$/.test(m)).sort().reverse();
        const chosen = stableFlash[0] ?? usable.find((m) => m.includes('flash')) ?? usable[0];
        console.log(`Gemini model in use: ${chosen}`);
        return chosen;
    } catch (err) {
        console.error('Could not list Gemini models:', err);
        return null;
    }
}

function activeModel(): Promise<string | null> {
    if (!modelCache) modelCache = chooseModel();
    return modelCache;
}

// Asks Gemini for JSON that matches the instructions. Returns null on any failure.
export async function askJson<T>(opts: {
    system: string;
    prompt: string;
    userKey: string; // who the call is for, used for the daily limit
}): Promise<T | null> {
    if (!aiEnabled()) return null;
    if (!withinDailyLimit(opts.userKey)) return null;

    try {
        const model = await activeModel();
        if (!model) return null;
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': API_KEY,
            },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: opts.system }] },
                contents: [{ role: 'user', parts: [{ text: redact(opts.prompt) }] }],
                generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) {
            console.error(`Gemini returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
            return null;
        }
        const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) return null;
        countUse(opts.userKey);
        return JSON.parse(text) as T;
    } catch (err) {
        console.error('Gemini call failed:', err);
        return null;
    }
}
