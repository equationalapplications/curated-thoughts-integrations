#!/usr/bin/env python3
"""mock_openai.py — a scripted OpenAI Chat Completions endpoint for the
Docker Agent host contract (spec 2026-10-16-docker-agent-integration-design.md,
"CI host contract").

Docker Agent talks to it through a custom provider
(`providers.<name>.base_url: http://127.0.0.1:<port>/v1`,
`api_type: openai_chatcompletions`). Every request body is appended to
`<record>` (JSON Lines) so the contract can assert what the model was sent;
replies come from `<script>`, a JSON list consumed in order. Each item is
either {"text": "..."} or {"tool_calls": [{"name": ..., "arguments": {...}}]}.
When the script runs out, the reply is {"text": "done"}.

Usage: mock_openai.py <script.json> <record.jsonl> <port-file>
The server binds 127.0.0.1:0 and writes the chosen port to <port-file>.
Stdlib only. Test infrastructure: never shipped behavior.
"""

from __future__ import annotations

import http.server
import json
import sys
import threading
import time

_lock = threading.Lock()
_state = {"script": [], "record": None, "n": 0}


def _next_reply():
    with _lock:
        script = _state["script"]
        reply = script.pop(0) if script else {"text": "done"}
        _state["n"] += 1
        return reply, _state["n"]


def _chunk(cid, delta, finish=None):
    return {
        "id": cid, "object": "chat.completion.chunk", "created": int(time.time()),
        "model": "mock-model",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }


def _events(reply, n):
    cid = "chatcmpl-mock-%d" % n
    out = [_chunk(cid, {"role": "assistant", "content": ""})]
    if reply.get("tool_calls"):
        for i, call in enumerate(reply["tool_calls"]):
            out.append(_chunk(cid, {"tool_calls": [{
                "index": i, "id": "call_mock_%d_%d" % (n, i), "type": "function",
                "function": {"name": call["name"],
                             "arguments": json.dumps(call.get("arguments", {}))},
            }]}))
        out.append(_chunk(cid, {}, "tool_calls"))
    else:
        out.append(_chunk(cid, {"content": reply.get("text", "")}))
        out.append(_chunk(cid, {}, "stop"))
    usage = dict(_chunk(cid, {}), choices=[])
    usage["usage"] = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
    out.append(usage)
    return out


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def do_GET(self):  # /v1/models probes
        body = json.dumps({"object": "list", "data": [{"id": "mock-model", "object": "model"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw.decode("utf-8"))
        except ValueError:
            body = {"_raw": raw.decode("utf-8", "replace")}
        reply, n = _next_reply()
        with _lock:
            with open(_state["record"], "a", encoding="utf-8") as handle:
                handle.write(json.dumps({"n": n, "path": self.path, "body": body}) + "\n")
        if not isinstance(body, dict) or not body.get("stream"):
            message = {"role": "assistant", "content": reply.get("text", "")}
            if reply.get("tool_calls"):
                message["tool_calls"] = [{
                    "id": "call_mock_%d_%d" % (n, i), "type": "function",
                    "function": {"name": c["name"], "arguments": json.dumps(c.get("arguments", {}))},
                } for i, c in enumerate(reply["tool_calls"])]
            payload = json.dumps({
                "id": "chatcmpl-mock-%d" % n, "object": "chat.completion", "model": "mock-model",
                "choices": [{"index": 0, "message": message,
                             "finish_reason": "tool_calls" if reply.get("tool_calls") else "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        data = b"".join(b"data: " + json.dumps(e).encode() + b"\n\n" for e in _events(reply, n))
        data += b"data: [DONE]\n\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main(argv):
    script_path, record_path, port_file = argv[1:4]
    with open(script_path, encoding="utf-8") as handle:
        _state["script"] = json.load(handle)
    _state["record"] = record_path
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    with open(port_file, "w", encoding="utf-8") as handle:
        handle.write(str(server.server_address[1]))
    server.serve_forever()


if __name__ == "__main__":
    main(sys.argv)
