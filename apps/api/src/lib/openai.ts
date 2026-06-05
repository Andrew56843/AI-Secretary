import http from "node:http";
import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { env } from "../config.js";

const OPENAI_TIMEOUT_MS = 45_000;

type JsonObject = Record<string, unknown>;

function createProxyAgent(proxyUrl: string) {
  if (proxyUrl.startsWith("socks://") || proxyUrl.startsWith("socks4://") || proxyUrl.startsWith("socks5://")) {
    return new SocksProxyAgent(proxyUrl) as unknown as http.Agent;
  }

  return new HttpsProxyAgent(proxyUrl) as unknown as http.Agent;
}

function parseJsonBody(body: string) {
  try {
    return JSON.parse(body) as JsonObject;
  } catch {
    return { raw: body };
  }
}

export class OpenAiRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly payload?: JsonObject
  ) {
    super(message);
  }
}

export async function postOpenAiJson<T extends JsonObject>(path: string, payload: JsonObject): Promise<T> {
  if (!env.OPENAI_API_KEY) {
    throw new OpenAiRequestError("OPENAI_API_KEY is not configured", 503);
  }

  const baseUrl = env.OPENAI_BASE_URL.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${baseUrl}${normalizedPath}`);
  const body = JSON.stringify(payload);
  const proxyUrl = env.OPENAI_PROXY_URL ?? env.SOCKS_PROXY_URL;
  const agent = proxyUrl ? createProxyAgent(proxyUrl) : undefined;
  const transport = url.protocol === "http:" ? http : https;

  return new Promise<T>((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: "POST",
        agent,
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        },
        timeout: OPENAI_TIMEOUT_MS
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const responseText = Buffer.concat(chunks).toString("utf8");
          const responsePayload = parseJsonBody(responseText);

          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new OpenAiRequestError("OpenAI request failed", response.statusCode, responsePayload));
            return;
          }

          resolve(responsePayload as T);
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new OpenAiRequestError("OpenAI request timed out", 504));
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}
