import { Router, type IRouter } from "express";
import { SearchWebBody, SearchWebResponse } from "@workspace/api-zod";

const router: IRouter = Router();
const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

function getSafeResultUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function clip(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1).trimEnd()}…` : value;
}

router.post("/search", async (req, res): Promise<void> => {
  const parsed = SearchWebBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a web search query between 2 and 300 characters." });
    return;
  }

  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey) {
    res.status(503).json({
      error: "Web search is not configured yet. Add a Tavily API key as a server-side secret to enable it.",
    });
    return;
  }

  try {
    const response = await fetch(TAVILY_SEARCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: parsed.data.query,
        search_depth: "basic",
        max_results: 5,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      req.log.warn({ providerStatus: response.status }, "Tavily search request failed");
      if (response.status === 429) {
        res.status(429).json({
          error: "Tavily's free search limit or rate limit was reached. Try again after it resets; no paid search fallback was used.",
        });
        return;
      }
      if (response.status === 401 || response.status === 403) {
        res.status(502).json({
          error: "The search provider rejected its server-side key. Check the Tavily secret configuration.",
        });
        return;
      }
      res.status(502).json({
        error: "The web search provider could not return results just now. Please try again.",
      });
      return;
    }

    const payload: unknown = await response.json();
    const rawResults = typeof payload === "object" && payload !== null && "results" in payload
      ? (payload as { results?: unknown }).results
      : undefined;
    if (!Array.isArray(rawResults)) {
      req.log.error("Tavily returned an invalid search response");
      res.status(502).json({ error: "The search provider returned an invalid response." });
      return;
    }

    const results = rawResults.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const item = entry as Record<string, unknown>;
      const title = typeof item.title === "string" ? item.title.trim() : "";
      const snippet = typeof item.content === "string" ? item.content.trim() : "";
      const url = getSafeResultUrl(item.url);
      if (!title || !snippet || !url) return [];
      return [{ title: clip(title, 200), snippet: clip(snippet, 500), url }];
    });

    res.json(SearchWebResponse.parse({ query: parsed.data.query, results }));
  } catch {
    req.log.error("Tavily search request failed before returning results");
    res.status(502).json({
      error: "Zaydan AI could not reach the web search provider. Please try again.",
    });
  }
});

export default router;
