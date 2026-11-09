from __future__ import annotations

import json
import uuid
from typing import Any

from google import genai
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import PrivateAttr


class GeminiInteractionsChatModel(BaseChatModel):
    model_name: str
    api_key: str
    timeout: float = 120.0

    _client: Any = PrivateAttr()
    _async_client: Any = PrivateAttr()

    def model_post_init(self, __context: Any) -> None:
        self._client = genai.Client(api_key=self.api_key)
        self._async_client = self._client.aio

    @property
    def _llm_type(self) -> str:
        return "gemini-interactions"

    @property
    def _identifying_params(self) -> dict[str, Any]:
        return {"model_name": self.model_name}

    def bind_tools(self, tools: list[Any], **kwargs: Any) -> Any:
        converted = []

        for tool in tools:
            if isinstance(tool, dict) and "function" in tool:
                function = tool["function"]
                converted.append({
                    "type": "function",
                    "name": function["name"],
                    "description": function.get("description", ""),
                    "parameters": function.get(
                        "parameters",
                        {"type": "object", "properties": {}},
                    ),
                })
            else:
                converted.append(tool)

        return self.bind(tools=converted, **kwargs)

    def _prepare(self, messages: list[BaseMessage]) -> tuple[str, list[dict]]:
        system = ""
        inputs: list[dict] = []

        for message in messages:
            if isinstance(message, SystemMessage):
                system += str(message.content) + "\n"

            elif isinstance(message, HumanMessage):
                inputs.append({
                    "type": "user_input",
                    "content": [{"type": "text", "text": str(message.content)}],
                })

            elif isinstance(message, AIMessage):
                saved_steps = message.additional_kwargs.get("gemini_steps")
                if saved_steps:
                    inputs.extend(saved_steps)
                elif message.content:
                    inputs.append({
                        "type": "model_output",
                        "content": [{"type": "text", "text": str(message.content)}],
                    })

            elif isinstance(message, ToolMessage):
                inputs.append({
                    "type": "function_result",
                    "name": message.name or "tool",
                    "call_id": message.tool_call_id,
                    "result": str(message.content),
                })

        return system.strip(), inputs

    def _request_args(
        self,
        messages: list[BaseMessage],
        kwargs: dict[str, Any],
    ) -> dict[str, Any]:
        system, inputs = self._prepare(messages)

        args: dict[str, Any] = {
            "model": self.model_name,
            "input": inputs,
            "store": False,
            "generation_config": {"thinking_level": "low"},
        }

        if system:
            args["system_instruction"] = system

        if kwargs.get("tools"):
            args["tools"] = kwargs["tools"]

        max_tokens = kwargs.get("max_tokens")
        if max_tokens:
            args["generation_config"]["max_output_tokens"] = max_tokens

        temperature = kwargs.get("temperature")
        if temperature is not None:
            args["generation_config"]["temperature"] = temperature

        return args

    def _convert_response(self, response: Any) -> ChatResult:
        steps = []
        tool_calls = []

        for step in getattr(response, "steps", []) or []:
            if hasattr(step, "model_dump"):
                raw = step.model_dump(exclude_none=True)
            else:
                raw = dict(step) if isinstance(step, dict) else {}

            if raw:
                steps.append(raw)

            step_type = raw.get("type", getattr(step, "type", ""))

            if step_type == "function_call":
                arguments = raw.get("arguments", getattr(step, "arguments", {}))
                if isinstance(arguments, str):
                    try:
                        arguments = json.loads(arguments)
                    except json.JSONDecodeError:
                        arguments = {}

                tool_calls.append({
                    "name": raw.get("name", getattr(step, "name", "")),
                    "args": arguments or {},
                    "id": raw.get("id") or str(uuid.uuid4()),
                    "type": "tool_call",
                })

        content = getattr(response, "output_text", "") or ""

        usage_metadata = None
        usage = getattr(response, "usage", None)

        if usage:
            input_tokens = getattr(usage, "input_tokens", 0) or 0
            output_tokens = getattr(usage, "output_tokens", 0) or 0
            usage_metadata = {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "total_tokens": input_tokens + output_tokens,
            }

        message = AIMessage(
            content=content,
            tool_calls=tool_calls,
            additional_kwargs={"gemini_steps": steps},
            usage_metadata=usage_metadata,
        )

        return ChatResult(
            generations=[ChatGeneration(message=message)]
        )

    async def _agenerate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        args = self._request_args(messages, kwargs)
        response = await self._async_client.interactions.create(
            **args,
            timeout=self.timeout,
        )
        return self._convert_response(response)

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        args = self._request_args(messages, kwargs)
        response = self._client.interactions.create(
            **args,
            timeout=self.timeout,
        )
        return self._convert_response(response)