import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  InjectorError,
  parseFeedlingApiUrl,
  parseTimeout,
  triggerForReason,
} from "../integrations/feedling-io/inject.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const injector = path.join(root, "integrations/feedling-io/inject.mjs");

async function startServer(handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: body ? JSON.parse(body) : null,
    });
    handler(requests.at(-1), response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function runInjector(apiUrl, { reason = "game_turn_required", apiKey = "feedling-secret" } = {}) {
  const child = spawn(process.execPath, [injector], {
    cwd: root,
    env: {
      ...process.env,
      FEEDLING_API_URL: apiUrl,
      FEEDLING_API_KEY: apiKey,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(
    `${JSON.stringify({
      version: 1,
      type: "garden_wake",
      reason,
      message: "服务端文案不应被伪装成用户消息。",
    })}\n`,
  );
  const [code] = await once(child, "exit");
  return { code, stdout, stderr };
}

test("enqueues one non-manual Feedling proactive event with the Garden reason", async () => {
  const server = await startServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ enqueued: true, job: { job_id: "pj_garden" } }));
  });
  try {
    const result = await runInjector(server.url);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      accepted: true,
      trigger: "garden_wake_game_turn_required",
      jobId: "pj_garden",
    });
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].method, "POST");
    assert.equal(server.requests[0].url, "/v1/proactive/tick");
    assert.equal(server.requests[0].headers["x-api-key"], "feedling-secret");
    assert.deepEqual(server.requests[0].body, {
      trigger: "garden_wake_game_turn_required",
    });
    assert.equal("context_hint" in server.requests[0].body, false);
    assert.equal("manual" in server.requests[0].body, false);
  } finally {
    await server.close();
  }
});

test("fails closed when Feedling does not enqueue the wake", async () => {
  const server = await startServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        enqueued: false,
        job: null,
        decision: { block_reason: "activation_pending" },
      }),
    );
  });
  try {
    const result = await runInjector(server.url);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /activation_pending/);
  } finally {
    await server.close();
  }
});

test("does not expose the Feedling API key in rejection output", async () => {
  const server = await startServer((_request, response) => {
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ detail: "invalid credential" }));
  });
  try {
    const result = await runInjector(server.url, { apiKey: "never-print-this" });
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr, /never-print-this/);
    assert.match(result.stderr, /invalid credential/);
  } finally {
    await server.close();
  }
});

test("normalizes reasons into bounded Feedling trigger tokens", () => {
  assert.equal(
    triggerForReason("forum_notification_available"),
    "garden_wake_forum_notification_available",
  );
  assert.ok(triggerForReason("花园通知").startsWith("garden_wake_reason_"));
  assert.ok(triggerForReason("x".repeat(500)).length <= 120);
});

test("validates Feedling endpoint and timeout", () => {
  assert.equal(parseFeedlingApiUrl("https://api.feedling.app").protocol, "https:");
  assert.equal(parseFeedlingApiUrl("http://127.0.0.1:8000").protocol, "http:");
  assert.throws(() => parseFeedlingApiUrl("http://api.example.test"), InjectorError);
  assert.equal(parseTimeout(undefined), 15_000);
  assert.throws(() => parseTimeout("999"), InjectorError);
});
