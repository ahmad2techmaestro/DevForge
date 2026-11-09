"""MCP: inspect a server's tools (the 'Test connection' button)."""

from __future__ import annotations

from fastapi import APIRouter, Request

from app.errors import ApiError
from app.mcp.client import McpError, McpPolicy, McpServerConfig, inspect_server
from app.types import JsonDict

router = APIRouter()


@router.post("/mcp/inspect")
async def mcp_inspect(cfg: McpServerConfig, request: Request) -> JsonDict:
    s = request.app.state.settings
    try:
        return {"ok": True, **await inspect_server(cfg, McpPolicy(
            allow_stdio=s.mcp_allow_stdio, allow_private_http=s.mcp_allow_private))}
    except McpError as e:
        raise ApiError(502, "mcp_unavailable", str(e)) from None
