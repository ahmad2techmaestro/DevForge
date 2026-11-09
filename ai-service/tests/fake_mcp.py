"""Tiny stdio MCP server for tests: tools echo, add, boom (isError), secret_env (reads FAKE_TOKEN)."""

import json
import os
import sys

TOOLS = [
    {"name": "echo", "description": "Echo text", "annotations": {"readOnlyHint": True},
     "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
    {"name": "add", "description": "Add numbers", "inputSchema": {"type": "object", "properties": {"a": {"type": "number"}, "b": {"type": "number"}}}},
    {"name": "boom", "description": "Always fails", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "token_len", "description": "Length of FAKE_TOKEN env", "inputSchema": {"type": "object", "properties": {}}},
]


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


print("hello banner that is not json", flush=True)
for line in sys.stdin:
    msg = json.loads(line)
    mid, method = msg.get("id"), msg.get("method")
    if mid is None:
        continue
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": "2025-03-26", "capabilities": {}, "serverInfo": {"name": "fake", "version": "0"}}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}})
    elif method == "tools/call":
        p = msg["params"]
        a = p.get("arguments", {})
        if p["name"] == "echo":
            out = {"content": [{"type": "text", "text": a["text"]}]}
        elif p["name"] == "add":
            out = {"content": [{"type": "text", "text": str(a["a"] + a["b"])}]}
        elif p["name"] == "token_len":
            out = {"content": [{"type": "text", "text": str(len(os.environ.get("FAKE_TOKEN", "")))}, {"type": "text", "text": "HOME=" + str("SECRET_PARENT" in os.environ)}]}
        else:
            out = {"content": [{"type": "text", "text": "kaboom"}], "isError": True}
        send({"jsonrpc": "2.0", "id": mid, "result": out})
    else:
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "nope"}})
