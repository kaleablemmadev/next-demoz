// src/ai.ts
// Gemini connection for the bot. Every feature must work without it: askJson returns null when the key is
// missing, the daily limit is reached, or the call fails. Callers then fall back to the normal forms.
//
// Settings (Render environment variables):
//   GEMINI_API_KEY   required to switch the AI on
//   GEMINI_MODEL     optional, a model name the key can use; it is tried first
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

// Models this key can use, in the order to try them. Looked up once from Gemini.
let modelCache: Promise<string[]> | null = null;

async function chooseModels(): Promise<string[]> {
    const wanted = process.env.GEMINI_MODEL?.trim();
    try {
        const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
            headers: { 'x-goog-api-key': API_KEY },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) {
            console.error(`Gemini model list returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
            return [];
        }
        const body = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
        const usable = (body.models ?? [])
            .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
            .map((m) => m.name.replace(/^models\//, ''));
        if (usable.length === 0) {
            console.error('This Gemini key has no models that support generateContent');
            return [];
        }
        // GEMINI_MODEL first if usable; then stable flash models (newest first); then other flash; then the rest.
        const stableFlash = usable.filter((m) => /^gemini-[\d.]+-flash$/.test(m)).sort().reverse();
        const otherFlash = usable.filter((m) => m.includes('flash') && !stableFlash.includes(m));
        const ordered = [
            ...(wanted && usable.includes(wanted) ? [wanted] : []),
            ...stableFlash,
            ...otherFlash,
            ...usable,
        ];
        const candidates = [...new Set(ordered)].slice(0, 4);
        console.log(`Gemini models in order: ${candidates.join(', ')}`);
        return candidates;
    } catch (err) {
        console.error('Could not list Gemini models:', err);
        return [];
    }
}

function activeModels(): Promise<string[]> {
    if (!modelCache) modelCache = chooseModels();
    return modelCache;
}

const OVERLOADED = new Set([404, 429, 503]);

// Asks Gemini for JSON that matches the instructions. Returns null on any failure.
export async function askJson<T>(opts: {
    system: string;
    prompt: string;
    userKey: string; // who the call is for, used for the daily limit
}): Promise<T | null> {
    if (!aiEnabled()) return null;
    if (!withinDailyLimit(opts.userKey)) return null;

    try {
        const models = await activeModels();
        if (models.length === 0) return null;

        const payload = JSON.stringify({
            systemInstruction: { parts: [{ text: opts.system }] },
            contents: [{ role: 'user', parts: [{ text: redact(opts.prompt) }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
        });
        const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY };

        // Each model is tried in order. An overloaded, rate-limited or missing model is retried once, then the next one is tried.
        let res: Response | null = null;
        for (const model of models) {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
            res = await fetch(url, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(TIMEOUT_MS) });
            if (res.status === 503 || res.status === 429) {
                await new Promise((r) => setTimeout(r, 2000));
                res = await fetch(url, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(TIMEOUT_MS) });
            }
            if (res.ok || !OVERLOADED.has(res.status)) break;
            console.error(`Gemini model ${model} returned ${res.status}, trying the next model`);
        }

        if (!res || !res.ok) {
            const detail = res ? (await res.text()).slice(0, 300) : 'no response';
            console.error(`Gemini returned ${res?.status ?? 'nothing'}: ${detail}`);
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
