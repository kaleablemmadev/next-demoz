// src/ai.ts
// Gemini connection for the bot. Every feature must work without it: askJson returns null when the key is
// missing, the daily limit is reached, or the call fails. Callers then fall back to the normal forms.
//
// Settings (Render environment variables):
//   GEMINI_API_KEY   required to switch the AI on
//   GEMINI_MODEL     optional, defaults to gemini-2.5-flash
//   AI_DAILY_LIMIT   optional, requests per person per day, defaults to 30

const API_KEY = process.env.GEMINI_API_KEY?.trim() || '';
const MODEL = process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';
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

// Asks Gemini for JSON that matches the instructions. Returns null on any failure.
export async function askJson<T>(opts: {
    system: string;
    prompt: string;
    userKey: string; // who the call is for, used for the daily limit
}): Promise<T | null> {
    if (!aiEnabled()) return null;
    if (!withinDailyLimit(opts.userKey)) return null;

    try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
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
            console.error(`Gemini returned ${res.status}`);
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
