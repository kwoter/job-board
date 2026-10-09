// Reads a handwritten job list (PNG from the app) and splits it into separate jobs.
// verify_jwt is ON, so only a signed-in Field user can call it. The Anthropic key
// lives in cal_config (service role only) and never reaches the browser.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MODEL = "claude-opus-5-5";
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...headers, "Content-Type": "application/json" } });

const PROMPT = `This is a photo of a page someone has handwritten with an Apple Pencil. It is a list of jobs they need to do.

Read the handwriting and return every separate job as its own item, in the order written.
- One job per item. If a line is clearly a continuation of the line above, join them.
- If several jobs are written on one line separated by commas, "and" or slashes, split them only when they are clearly different jobs.
- Ignore headings such as "Jobs" or "To do", bullets, numbers, tick boxes and crossed-out words.
- Fix obvious spelling slips, keep the person's wording otherwise. Capitalise the first letter.
- If a word is genuinely unreadable, give your best guess.
- If the page has no readable jobs, return an empty list.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who } = await sb.auth.getUser(token);
  if (!who?.user) return json({ error: "not signed in" }, 401);

  const body = await req.json().catch(() => ({}));
  const image = String(body.image || "").replace(/^data:image\/\w+;base64,/, "");
  if (!image) return json({ error: "no image" }, 400);
  if (image.length > 6_000_000) return json({ error: "page too large" }, 413);

  const { data: config } = await sb.from("cal_config").select("anthropic_api_key").eq("id", 1).single();
  const key = config?.anthropic_api_key;
  if (!key) return json({ error: "reader not set up" }, 503);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      tools: [{
        name: "save_jobs",
        description: "Save the separate jobs read from the page.",
        input_schema: {
          type: "object",
          properties: { jobs: { type: "array", items: { type: "string" } } },
          required: ["jobs"],
        },
      }],
      tool_choice: { type: "tool", name: "save_jobs" },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: image } },
          { type: "text", text: PROMPT },
        ],
      }],
    }),
  });
  if (!res.ok) {
    console.error("anthropic", res.status, await res.text());
    return json({ error: "reader failed" }, 502);
  }
  const out = await res.json();
  const call = (out.content || []).find((c: { type: string }) => c.type === "tool_use");
  const jobs = (call?.input?.jobs || [])
    .map((j: unknown) => String(j).replace(/\s+/g, " ").trim())
    .filter((j: string) => j.length > 1)
    .slice(0, 60);
  return json({ jobs });
});
