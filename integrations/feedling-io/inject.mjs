#!/usr/bin/env node

import { createHash } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TRIGGER_LENGTH = 120;

export class InjectorError extends Error {
  constructor(message) {
    super(message);
    this.name = "InjectorError";
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InjectorError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

export function parseTimeout(value) {
  if (value === undefined || value === "") return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 120_000) {
    throw new InjectorError(
      "FEEDLING_GARDEN_INJECTOR_TIMEOUT_MS must be an integer from 1000 to 120000",
    );
  }
  return parsed;
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function parseFeedlingApiUrl(value) {
  let url;
  try {
    url = new URL(requireString(value, "FEEDLING_API_URL"));
  } catch (error) {
    if (error instanceof InjectorError) throw error;
    throw new InjectorError("FEEDLING_API_URL must be a valid URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new InjectorError(
      "FEEDLING_API_URL must not contain credentials, a query, or a fragment",
    );
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new InjectorError("FEEDLING_API_URL must use HTTPS unless it points to localhost");
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
  return url;
}

export async function readEnvelope(input) {
  let body = "";
  input.setEncoding("utf8");
  for await (const chunk of input) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > MAX_INPUT_BYTES) {
      throw new InjectorError(`stdin exceeds ${MAX_INPUT_BYTES} bytes`);
    }
  }

  let envelope;
  try {
    envelope = JSON.parse(body);
  } catch {
    throw new InjectorError("stdin must contain one JSON wake envelope");
  }
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    envelope.version !== 1 ||
    envelope.type !== "garden_wake"
  ) {
    throw new InjectorError("unsupported wake envelope");
  }
  return {
    reason: requireString(envelope.reason, "wake reason"),
    message: requireString(envelope.message, "wake message"),
  };
}

export function triggerForReason(reason) {
  const normalized = requireString(reason, "wake reason")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/gu, "_")
    .replace(/^[_\-.:]+|[_\-.:]+$/gu, "");
  const digest = createHash("sha256").update(reason, "utf8").digest("hex").slice(0, 12);
  const body = normalized || `reason_${digest}`;
  const prefix = "garden_wake_";
  if (prefix.length + body.length <= MAX_TRIGGER_LENGTH) return `${prefix}${body}`;
  const available = MAX_TRIGGER_LENGTH - prefix.length - digest.length - 1;
  return `${prefix}${body.slice(0, available)}_${digest}`;
}

async function boundedResponseText(response) {
  const text = await response.text();
  return text.slice(0, MAX_RESPONSE_BYTES);
}

function responseReason(body, status) {
  if (body && typeof body === "object") {
    const decision = body.decision && typeof body.decision === "object" ? body.decision : {};
    return String(
      decision.block_reason || decision.reason || body.detail || body.error || `HTTP ${status}`,
    ).slice(0, 240);
  }
  return `HTTP ${status}`;
}

export async function injectWake({
  apiUrl,
  apiKey,
  timeoutMs,
  reason,
  fetchImpl = fetch,
}) {
  const trigger = triggerForReason(reason);
  const endpoint = new URL("v1/proactive/tick", apiUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({ trigger }),
      signal: controller.signal,
    });
  } catch (error) {
    const detail = error?.name === "AbortError" ? "request timed out" : "request failed";
    throw new InjectorError(`Feedling proactive injection ${detail}`);
  } finally {
    clearTimeout(timer);
  }

  const raw = await boundedResponseText(response);
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new InjectorError(
      `Feedling proactive injection rejected: ${responseReason(body, response.status)}`,
    );
  }
  if (!body || body.enqueued !== true || !body.job) {
    throw new InjectorError(
      `Feedling did not enqueue the Garden wake: ${responseReason(body, response.status)}`,
    );
  }
  const jobId = String(body.job.job_id || body.job.id || "").trim();
  if (!jobId) {
    throw new InjectorError("Feedling accepted the request without a proactive job id");
  }
  return { accepted: true, trigger, jobId };
}

export async function main({ input = process.stdin, output = process.stdout, env = process.env } = {}) {
  const envelope = await readEnvelope(input);
  const apiUrl = parseFeedlingApiUrl(env.FEEDLING_API_URL);
  const apiKey = requireString(env.FEEDLING_API_KEY, "FEEDLING_API_KEY");
  const result = await injectWake({
    apiUrl,
    apiKey,
    timeoutMs: parseTimeout(env.FEEDLING_GARDEN_INJECTOR_TIMEOUT_MS),
    reason: envelope.reason,
  });
  output.write(`${JSON.stringify(result)}\n`);
}

const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isEntrypoint) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
