"""Sequenced, disk-persisted run events with ordered, retried callback delivery."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime
from pathlib import Path

import httpx

from app.types import JsonDict

log = logging.getLogger("devforge.events")


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class EventLog:
    def __init__(
        self,
        path: Path,
        callback_url: str,
        internal_key: str,
        client: httpx.AsyncClient,
        *,
        retries: int = 3,
        backoff: float = 0.5,
    ) -> None:
        self.path = path
        self.callback_url = callback_url
        self.internal_key = internal_key
        self.client = client
        self.retries = retries
        self.backoff = backoff
        self.events: list[JsonDict] = []
        self._queue: asyncio.Queue[JsonDict | None] = asyncio.Queue()
        self._worker: asyncio.Task[None] | None = None
        path.parent.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def load(path: Path) -> list[JsonDict]:
        if not path.exists():
            return []
        out: list[JsonDict] = []
        for line in path.read_text("utf-8").splitlines():
            try:
                out.append(json.loads(line))
            except ValueError:
                continue  # torn final line after a crash
        return out

    async def emit(self, type_: str, data: JsonDict) -> JsonDict:
        event: JsonDict = {"seq": len(self.events) + 1, "type": type_, "ts": now_iso(), "data": data}
        self.events.append(event)
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(event) + "\n")
        if self._worker is None:
            self._worker = asyncio.create_task(self._deliver_loop())
        self._queue.put_nowait(event)
        return event

    async def _deliver_loop(self) -> None:
        while True:
            event = await self._queue.get()
            try:
                if event is None:
                    return
                await self._deliver(event)
            finally:
                self._queue.task_done()

    async def _deliver(self, event: JsonDict) -> None:
        for attempt in range(self.retries):
            try:
                resp = await self.client.post(
                    self.callback_url, json=event, headers={"X-Internal-Key": self.internal_key}, timeout=10.0
                )
                if resp.status_code < 300:
                    return
                reason = f"HTTP {resp.status_code}"
            except httpx.HTTPError as exc:
                reason = type(exc).__name__
            if attempt < self.retries - 1:
                await asyncio.sleep(self.backoff * (2**attempt))
            else:
                log.warning("giving up delivering event seq=%s type=%s: %s", event["seq"], event["type"], reason)

    async def flush(self) -> None:
        """Wait until every queued event has been delivered (or given up on)."""
        if self._worker is not None:
            await self._queue.join()

    async def close(self) -> None:
        await self.flush()
        if self._worker is not None:
            self._queue.put_nowait(None)
            await self._worker
            self._worker = None
