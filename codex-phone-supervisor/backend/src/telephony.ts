import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import twilio from "twilio";
import { WebSocketServer, type WebSocket } from "ws";
import { config } from "./config.js";
import { appendAuditEvent, getSession } from "./store.js";
import { ensureTelephonySession } from "./telephony-store.js";
import { handleUserMessage } from "./agent-core.js";
import { registerProgressSink } from "./progress-broadcaster.js";

const relayPath = "/twilio/conversation-relay";

function requestUrl(req: Request) {
  if (!config.publicBaseUrl) throw new Error("CODEX_PHONE_SUPERVISOR_PUBLIC_BASE_URL is required for Twilio signature validation.");
  return `${config.publicBaseUrl.replace(/\/$/, "")}${req.originalUrl}`;
}

function validateTwilioRequest(req: Request) {
  if (!config.validateTwilioSignatures) return true;
  if (!config.twilioAuthToken) return false;
  const signature = req.get("X-Twilio-Signature") || "";
  return twilio.validateRequest(config.twilioAuthToken, signature, requestUrl(req), req.body || {});
}

function conversationRelayUrl(sessionId: string, callSid: string, from: string) {
  const url = new URL(config.conversationRelayWsUrl);
  url.searchParams.set("session_id", sessionId);
  url.searchParams.set("call_sid", callSid);
  url.searchParams.set("from", from);
  return url.toString();
}

function sendRelayText(ws: WebSocket, text: string) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type: "text", token: text, last: true }));
}

function promptText(event: Record<string, unknown>) {
  return String(event.voicePrompt || event.prompt || event.transcript || event.text || "").trim();
}

function sendVoiceConfigMessage(res: Response, message: string, statusCode = 200) {
  const response = new twilio.twiml.VoiceResponse();
  response.say(message);
  response.hangup();
  res.status(statusCode).type("text/xml").send(response.toString());
}

function sendSmsConfigMessage(res: Response, message: string) {
  const response = new twilio.twiml.MessagingResponse();
  response.message(message);
  res.type("text/xml").send(response.toString());
}

function parseRequestPath(rawUrl: string | undefined) {
  if (!rawUrl) return { pathname: "", searchParams: new URLSearchParams() };
  const [pathname, query = ""] = rawUrl.split("?");
  return { pathname, searchParams: new URLSearchParams(query) };
}

export function setupTwilioTelephony(app: Express, server: Server) {
  app.post("/twilio/voice", (req, res) => {
    if (!validateTwilioRequest(req)) {
      res.status(403).send("Forbidden");
      return;
    }

    if (!config.twilioVoiceEnabled) {
      appendAuditEvent({
        session_id: "twilio-voice-config",
        ts: new Date().toISOString(),
        source: "system",
        type: "twilio.voice.disabled",
        message: "Inbound voice webhook was called while Twilio voice is disabled.",
      });
      sendVoiceConfigMessage(res, "Codex Phone Supervisor voice calls are not enabled on this instance.");
      return;
    }

    if (!config.conversationRelayWsUrl) {
      appendAuditEvent({
        session_id: "twilio-voice-config",
        ts: new Date().toISOString(),
        source: "system",
        type: "twilio.voice.misconfigured",
        message: "TWILIO_CONVERSATION_RELAY_WS_URL is not configured.",
      });
      sendVoiceConfigMessage(res, "Codex Phone Supervisor voice calls are enabled, but Conversation Relay is not configured.", 503);
      return;
    }

    const callSid = String(req.body?.CallSid || req.body?.callSid || "").trim();
    const from = String(req.body?.From || "").trim();
    if (!callSid) {
      sendVoiceConfigMessage(res, "This Twilio call is missing its call identity.", 400);
      return;
    }
    if (!from) {
      sendVoiceConfigMessage(res, "This Twilio call is missing its caller identity.", 400);
      return;
    }
    const session = ensureTelephonySession(`voice:${callSid}`, "voice", from);
    const response = new twilio.twiml.VoiceResponse();
    const connect = response.connect();
    (connect as any).conversationRelay({
      url: conversationRelayUrl(session.session_id, callSid, from),
      welcomeGreeting: "Codex Phone Supervisor is connected. Ask what Codex is doing, approve a pending action, or give a new instruction.",
      interruptByDtmf: true,
      language: "en-US",
    });

    appendAuditEvent({
      session_id: session.session_id,
      ts: new Date().toISOString(),
      source: "system",
      type: "twilio.voice.connected",
      message: `Voice webhook connected call ${callSid}`,
      data: { callSid, from },
    });

    res.type("text/xml").send(response.toString());
  });

  app.post("/twilio/sms", async (req, res) => {
    if (!validateTwilioRequest(req)) {
      res.status(403).send("Forbidden");
      return;
    }

    if (!config.twilioSmsEnabled) {
      sendSmsConfigMessage(res, "Codex Phone Supervisor SMS is not enabled on this instance.");
      return;
    }

    const from = String(req.body?.From || "").trim();
    const body = String(req.body?.Body || "").trim();
    if (!from) {
      res.status(400).send("Missing From.");
      return;
    }
    const session = ensureTelephonySession(`sms:${from}`, "sms", from);
    const result = body
      ? await handleUserMessage({
          userId: from,
          channel: "twilio_sms",
          text: body,
          sessionId: session.session_id,
          externalConversationId: from,
          timestamp: new Date().toISOString(),
        })
      : { text: "Send a Codex status question, approval decision, or instruction." };

    const response = new twilio.twiml.MessagingResponse();
    response.message(result.text);
    res.type("text/xml").send(response.toString());
  });

  app.post("/twilio/message-status", (req, res) => {
    if (!validateTwilioRequest(req)) {
      res.status(403).send("Forbidden");
      return;
    }

    const messageSid = String(req.body?.MessageSid || "").trim();
    const messageStatus = String(req.body?.MessageStatus || "").trim();
    if (!messageSid || !messageStatus) {
      res.status(400).send("MessageSid and MessageStatus are required.");
      return;
    }
    appendAuditEvent({
      session_id: "twilio-message-status",
      ts: new Date().toISOString(),
      source: "system",
      type: "twilio.message.status",
      message: `${messageSid}: ${messageStatus}`,
      data: req.body,
    });
    res.sendStatus(204);
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = parseRequestPath(request.url);
    if (url.pathname !== relayPath) return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws, request) => {
    const url = parseRequestPath(request.url);
    const sessionId = url.searchParams.get("session_id") || "";
    const callSid = url.searchParams.get("call_sid") || "";
    const from = url.searchParams.get("from") || "";
    const session = (sessionId && getSession(sessionId)) || (callSid ? ensureTelephonySession(`voice:${callSid}`, "voice", from) : null);
    if (!session || !from) {
      sendRelayText(ws, "Missing supervisor session or caller identity for this call.");
      ws.close();
      return;
    }
    const unregisterProgressSink = registerProgressSink(session.session_id, {
      channel: "twilio_call",
      send: (text) => sendRelayText(ws, text),
    });
    ws.on("close", unregisterProgressSink);

    ws.on("message", (raw) => {
      let event: Record<string, unknown> = {};
      try {
        event = JSON.parse(String(raw));
      } catch {
        sendRelayText(ws, "I could not read that phone event.");
        return;
      }

      if (event.type === "connected") {
        appendAuditEvent({
          session_id: session.session_id,
          ts: new Date().toISOString(),
          source: "system",
          type: "twilio.relay.connected",
          message: `ConversationRelay connected for ${callSid}`,
          data: event,
        });
        return;
      }

      if (event.type === "interrupt") {
        appendAuditEvent({
          session_id: session.session_id,
          ts: new Date().toISOString(),
          source: "user",
          type: "twilio.relay.interrupt",
          message: "Caller interrupted spoken output.",
          data: event,
        });
        return;
      }

      if (event.type === "prompt") {
        const text = promptText(event);
        if (!text) {
          sendRelayText(ws, "I did not catch that.");
          return;
        }
        void handleUserMessage({
          userId: from,
          channel: "twilio_call",
          text,
          sessionId: session.session_id,
          externalConversationId: callSid,
          timestamp: new Date().toISOString(),
        })
          .then((result) => sendRelayText(ws, result.text))
          .catch((error) => sendRelayText(ws, `Supervisor error: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}
