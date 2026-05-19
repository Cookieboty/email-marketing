import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { processWebhookEvent, type WebhookEvent } from "@/lib/modules/webhook/handler";

export const runtime = "nodejs";

const log = logger.child("webhook/resend");

async function verifySvixSignature(
  body: string,
  headers: Headers,
  secret: string,
): Promise<boolean> {
  const msgId = headers.get("svix-id");
  const msgTimestamp = headers.get("svix-timestamp");
  const msgSignature = headers.get("svix-signature");

  if (!msgId || !msgTimestamp || !msgSignature) return false;

  const ts = parseInt(msgTimestamp, 10);
  if (isNaN(ts)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > 300) return false;

  const secretBytes = base64ToUint8Array(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  const toSign = new TextEncoder().encode(`${msgId}.${msgTimestamp}.${body}`);

  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes.buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, toSign);
  const computed = `v1,${uint8ArrayToBase64(new Uint8Array(sig))}`;

  const signatures = msgSignature.split(" ");
  return signatures.some((s) => timingSafeEqual(s, computed));
}

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function uint8ArrayToBase64(arr: Uint8Array): string {
  let bin = "";
  for (const byte of arr) bin += String.fromCharCode(byte);
  return btoa(bin);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function POST(request: Request): Promise<NextResponse> {
  const secret = env().RESEND_WEBHOOK_SECRET;
  if (!secret) {
    log.error("RESEND_WEBHOOK_SECRET not configured");
    return NextResponse.json({ error: "not configured" }, { status: 500 });
  }

  const body = await request.text();

  const valid = await verifySvixSignature(body, request.headers, secret);
  if (!valid) {
    log.warn("webhook signature verification failed");
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let event: WebhookEvent;
  try {
    event = JSON.parse(body) as WebhookEvent;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!event.type || !event.data) {
    return NextResponse.json({ error: "invalid event" }, { status: 400 });
  }

  try {
    const result = await processWebhookEvent(event);
    log.info("webhook processed", {
      type: event.type,
      idempotencyKey: result.idempotencyKey,
      processed: result.processed,
      reason: result.reason,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    log.error("webhook processing failed", {
      type: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "processing failed" }, { status: 500 });
  }
}
