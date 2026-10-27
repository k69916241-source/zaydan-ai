import { Router, type IRouter } from "express";
import {
  GetChatStatusResponse,
  SendChatMessageBody,
  SendChatMessageResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const systemPrompt = [
  "You are Zaydan AI, an intelligent, friendly, calm, and confident assistant.",
  "Support English, Hindi, and Hinglish. Follow the user's saved preferred language when provided; otherwise reply in the language the user uses.",
  "Answer directly. Be occasionally funny when it fits, but never force humor.",
  "Do not invent facts. State uncertainty clearly when you do not know.",
  "Only refer to messages included in this request; do not claim to remember unavailable chats or past sessions.",
].join(" ");

function getProviderConfig() {
  const baseUrl = process.env.ZAYDAN_AI_BASE_URL?.trim();
  const model = process.env.ZAYDAN_AI_MODEL?.trim();
  const apiKey = process.env.ZAYDAN_AI_API_KEY?.trim();

  if (!baseUrl || !model) return null;

  try {
    const parsedUrl = new URL(baseUrl);
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      return null;
    }
    if (parsedUrl.hostname === "api.groq.com" && !apiKey) {
      return null;
    }
  } catch {
    return null;
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ""), model, apiKey };
}

router.get("/chat/status", (_req, res): void => {
  const available = getProviderConfig() !== null;
  const message = available
    ? "A compatible AI model is connected."
    : "AI responses are not connected yet. A compatible model can be configured on the server.";

  res.json(GetChatStatusResponse.parse({ available, message }));
});

router.post("/chat", async (req, res): Promise<void> => {
  const parsed = SendChatMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Please send a valid chat message." });
    return;
  }

  const provider = getProviderConfig();
  if (!provider) {
    res.status(503).json({
      error: "AI is not connected yet. Your message was not answered by a model.",
    });
    return;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`;
  }

  try {
    const languageInstruction = parsed.data.preferredLanguage === "हिन्दी"
      ? "Reply in Hindi using Devanagari script."
      : parsed.data.preferredLanguage === "Hinglish"
        ? "Reply in natural Hinglish, mixing Hindi and English in Latin script."
        : parsed.data.preferredLanguage === "English"
          ? "Reply in English."
          : undefined;
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: provider.model,
        messages: [
          {
            role: "system",
            content: languageInstruction
              ? `${systemPrompt} ${languageInstruction}`
              : systemPrompt,
          },
          ...parsed.data.messages,
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });

    if (!response.ok) {
      req.log.error(
        { providerStatus: response.status },
        "Configured AI provider returned an error",
      );
      res.status(502).json({
        error: "The connected AI model could not answer just now. Please try again.",
      });
      return;
    }

    const payload: unknown = await response.json();
    const message =
      typeof payload === "object" && payload !== null && "choices" in payload
        ? (payload as {
            choices?: Array<{ message?: { content?: unknown } }>;
          }).choices?.[0]?.message?.content
        : undefined;

    if (typeof message !== "string" || !message.trim()) {
      req.log.error("Configured AI provider returned an invalid response");
      res.status(502).json({
        error: "The connected AI model returned an invalid response. Please try again.",
      });
      return;
    }

    res.json(SendChatMessageResponse.parse({ message: message.trim() }));
  } catch (error) {
    // Avoid logging provider request details or errors that could contain secrets.
    req.log.error("Configured AI provider request failed");
    res.status(502).json({
      error: "Zaydan AI could not reach the connected model. Please try again.",
    });
  }
});

export default router;
