"""Hermes tool handlers for a scoped ProserFactory API subset."""

from __future__ import annotations

import base64
from contextvars import ContextVar
import codecs
import hashlib
import hmac
import json
import logging
import math
import os
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable


_PLUGIN_DIR = Path(__file__).parent
_ENV_LOADED = False
_NOVA_CLIENT = ContextVar('proser_nova_client', default=None)
_NOVA_HEADERS = ContextVar('proser_nova_headers', default=None)
_NOVA_FAILURE = ContextVar('proser_nova_failure', default=None)
_LOGGER = logging.getLogger("hermes.proser_api")


class ProserClientError(Exception):
    """Typed local client failure safe for agent retry decisions."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code

PLUGIN_ACTION_ROUTES: dict[str, dict[str, tuple[str, str]]] = {
    "proser_books": {
        "list_books": ("GET", "/api/books"),
        "get_book": ("GET", "/api/books/{id}"),
        "create_book": ("POST", "/api/books"),
        "update_book": ("PUT", "/api/books/{id}"),
        "delete_book": ("DELETE", "/api/books/{id}"),
        "document_capabilities": ("GET", "/api/books/{bookId}/document-capabilities"),
        "document_manifest": ("GET", "/api/books/{bookId}/document-manifest"),
        "scene_document": ("GET", "/api/books/{bookId}/scenes/{sceneId}/document"),
        "scene_comments": ("GET", "/api/books/{bookId}/scenes/{sceneId}/document-comments"),
        "revalidate_scene_comment": ("POST", "/api/books/{bookId}/scenes/{sceneId}/document-comments/{commentId}/revalidate"),
        "resolve_scene_comment": ("POST", "/api/books/{bookId}/scenes/{sceneId}/document-comments/{commentId}/resolve"),
        "layout_story_comments": ("GET", "/api/books/{bookId}/layout-stories/{storyId}/document-comments"),
        "revalidate_layout_story_comment": ("POST", "/api/books/{bookId}/layout-stories/{storyId}/document-comments/{commentId}/revalidate"),
        "resolve_layout_story_comment": ("POST", "/api/books/{bookId}/layout-stories/{storyId}/document-comments/{commentId}/resolve"),
        "document_scope": ("GET", "/api/books/{bookId}/document-scopes/{scope}"),
        "document_commit": ("POST", "/api/books/{bookId}/document-commits"),
        "document_layout_commit": ("POST", "/api/books/{bookId}/document-layout-commits"),
        "document_operation": ("GET", "/api/books/{bookId}/document-operations/{operationId}"),
        "document_inference_operation": ("GET", "/api/books/{bookId}/document-inference-operations/{operationId}"),
        "cancel_document_inference_operation": ("POST", "/api/books/{bookId}/document-inference-operations/{operationId}/cancel"),
        "create_document_discussion": ("POST", "/api/books/{bookId}/document-discussions"),
        "document_discussion": ("GET", "/api/books/{bookId}/document-discussions/{discussionId}"),
        "discussion_proposals": ("GET", "/api/books/{bookId}/document-discussions/{discussionId}/proposals"),
        "request_document_proposal": ("POST", "/api/books/{bookId}/document-discussions/{discussionId}/proposals"),
        "document_proposal": ("GET", "/api/books/{bookId}/document-proposals/{proposalId}"),
        "cancel_document_proposal": ("POST", "/api/books/{bookId}/document-proposals/{proposalId}/cancel"),
        "revalidate_document_proposal": ("POST", "/api/books/{bookId}/document-proposals/{proposalId}/revalidate"),
        "apply_document_proposal": ("POST", "/api/books/{bookId}/document-proposals/{proposalId}/apply"),
        "document_restore": ("POST", "/api/books/{bookId}/document-revisions/{revisionId}/restore"),
        "operator_operations": ("GET", "/api/books/{bookId}/document-operator-effects"),
        "operator_operation": ("GET", "/api/books/{bookId}/document-operator-effects/{operationId}"),
        "cancel_operator_operation": ("POST", "/api/books/{bookId}/document-operator-effects/{operationId}/cancel"),
        "get_structure": ("GET", "/api/books/{bookId}/structure"),
        "save_structure": ("POST", "/api/books/{bookId}/structure"),
        "create_act": ("POST", "/api/books/{bookId}/acts"),
        "update_act": ("PUT", "/api/books/{bookId}/acts/{actId}"),
        "delete_act": ("DELETE", "/api/books/{bookId}/acts/{actId}"),
        "create_chapter": ("POST", "/api/books/{bookId}/acts/{actId}/chapters"),
        "update_chapter": ("PUT", "/api/books/{bookId}/chapters/{chapterId}"),
        "delete_chapter": ("DELETE", "/api/books/{bookId}/chapters/{chapterId}"),
        "list_scenes": ("GET", "/api/books/{bookId}/scenes"),
        "list_chapter_scenes": ("GET", "/api/books/{bookId}/chapters/{chapterId}/scenes"),
        "get_scene": ("GET", "/api/books/{bookId}/scenes/{sceneId}"),
        "create_scene": ("POST", "/api/books/{bookId}/chapters/{chapterId}/scenes"),
        "update_scene": ("PUT", "/api/books/{bookId}/scenes/{sceneId}"),
        "delete_scene": ("DELETE", "/api/books/{bookId}/scenes/{sceneId}"),
        "regenerate_scene": ("POST", "/api/books/{bookId}/scenes/{sceneId}/regenerate"),
        "latest_scene_trace": ("GET", "/api/books/{bookId}/scenes/{sceneId}/prose/traces/latest"),
        "submit_prose_preference": ("POST", "/api/books/{bookId}/scenes/{sceneId}/prose/preferences"),
        "list_notes": ("GET", "/api/books/{bookId}/notes"),
        "create_note": ("POST", "/api/books/{bookId}/notes"),
        "update_note": ("PUT", "/api/books/{bookId}/notes/{noteId}"),
        "delete_note": ("DELETE", "/api/books/{bookId}/notes/{noteId}"),
        "export_book": ("GET", "/api/books/{bookId}/export"),
    },
    "proser_exports": {
        "capabilities": ("GET", "/api/books/{bookId}/document-publication-capabilities"),
        "get_job": ("GET", "/api/books/{bookId}/document-publication-jobs/{jobId}"),
        "create_file": ("POST", "/api/books/{bookId}/export-artifacts"),
        "get_file": ("GET", "/api/books/{bookId}/export-artifacts/{artifactId}"),
        "read_file": ("GET", "/api/books/{bookId}/export-artifacts/{artifactId}/read"),
        "delete_file": ("DELETE", "/api/books/{bookId}/export-artifacts/{artifactId}"),
    },
    "proser_context": {
        "book_map": ("GET", "/api/books/{id}"),
        "scene_brief": ("GET", "/api/books/{bookId}/scenes/{sceneId}"),
        "codex_brief": ("GET", "/api/books/{bookId}/codex"),
        "search_scenes": ("GET", "/api/books/{bookId}/scenes"),
    },
    "proser_codex": {
        "list_entries": ("GET", "/api/books/{bookId}/codex"),
        "search": ("GET", "/api/books/{bookId}/codex/search"),
        "create_entry": ("POST", "/api/books/{bookId}/codex"),
        "get_entry": ("GET", "/api/codex/{id}"),
        "update_entry": ("PUT", "/api/codex/{id}"),
        "delete_entry": ("DELETE", "/api/codex/{id}"),
    },
    "proser_generate": {
        "character": ("POST", "/api/generate/character"),
        "location": ("POST", "/api/generate/location"),
        "item": ("POST", "/api/generate/item"),
        "codex": ("POST", "/api/generate/codex"),
        "outline": ("POST", "/api/generate/outline"),
        "summary": ("POST", "/api/generate/summary"),
        "title": ("POST", "/api/generate/title"),
        "tagline": ("POST", "/api/generate/tagline"),
        "inline_suggestion": ("POST", "/api/generate/inline-suggestion"),
        "feedback": ("POST", "/api/generate/feedback"),
        "structure": ("POST", "/api/generate/structure"),
        "prose": ("POST", "/api/generate/prose"),
        "batch_prose": ("POST", "/api/generate/prose/batch"),
        "revise_prose": ("POST", "/api/generate/prose/revise"),
        "command_revise": ("POST", "/api/generate/prose/command-revise"),
    },
    "proser_settings": {
        "get": ("GET", "/api/settings"),
        "update": ("PUT", "/api/settings"),
    },
    "proser_models": {
        "list": ("GET", "/api/models"),
        "status": ("GET", "/api/models/status"),
    },
    "proser_images": {
        "health": ("GET", "/api/images/health"),
        "list": ("GET", "/api/images/list"),
        "suggest_prompt": ("POST", "/api/images/suggest-prompt"),
        "generate": ("POST", "/api/images/generate"),
        "generate_flux": ("POST", "/api/images/generate/flux"),
    },
    "proser_editorial": {
        "list_passes": ("GET", "/api/editorial/pass-packs"),
        "resolve_profile": ("GET", "/api/books/{bookId}/editorial-profile/resolved"),
        "run_summary": ("GET", "/api/editorial/runs/{runId}/summary"),
        "list_proposals": ("GET", "/api/editorial/runs/{runId}/proposals"),
        "get_proposal": ("GET", "/api/editorial/runs/{runId}/proposals/{proposalId}"),
        "record_preference": ("POST", "/api/editorial/proposals/{proposalId}/preference"),
        "apply_proposal": ("POST", "/api/editorial/proposals/{proposalId}/apply"),
        "run_benchmark": ("POST", "/api/editorial/benchmarks"),
        "benchmark_status": ("GET", "/api/editorial/benchmarks/{runId}"),
        "benchmark_report": ("GET", "/api/editorial/benchmarks/{runId}/report"),
    },
}


def _json(data: dict[str, Any]) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def _load_plugin_env() -> None:
    global _ENV_LOADED
    if _ENV_LOADED:
        return
    _ENV_LOADED = True
    env_file = _PLUGIN_DIR / ".env"
    if not env_file.exists():
        return
    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _env(name: str, default: str = "") -> str:
    _load_plugin_env()
    return os.environ.get(name, default).strip()


def _base_url() -> str:
    value = _env("PROSER_BASE_URL").rstrip("/")
    if not value:
        raise ValueError("PROSER_BASE_URL is required")
    return value


def _base64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _sign_token() -> str:
    secret = _env("PROSER_AUTH_SECRET")
    if not secret and _env("PROSER_ALLOW_LEGACY_AUTH_SECRETS").lower() in {"1", "true", "yes"}:
        secret = _env("PROSER_NEXTAUTH_SECRET") or _env("NEXTAUTH_SECRET") or _env("AUTH_SECRET")
        if secret:
            _LOGGER.critical("SECURITY: using explicitly enabled legacy Proser authentication secret fallback")
    if not secret:
        raise ValueError("Set PROSER_TOKEN or the dedicated PROSER_AUTH_SECRET")

    github_id = _env("PROSER_GITHUB_ID", "service:hermes-agent")
    username = _env("PROSER_USERNAME", "hermes-agent")
    email = _env("PROSER_EMAIL")
    subject = _env("PROSER_SUB", github_id)
    issuer = _env("PROSER_TOKEN_ISSUER", "hermes-agent")
    audience = _env("PROSER_TOKEN_AUDIENCE", "proser-factory")
    now = int(time.time())
    ttl = int(_env("PROSER_TOKEN_TTL_SECONDS", "600") or "600")

    header = {"alg": "HS256", "typ": "JWT"}
    payload: dict[str, Any] = {
        "iss": issuer,
        "aud": audience,
        "sub": subject,
        "githubId": github_id,
        "username": username,
        "iat": now,
        "exp": now + ttl,
    }
    owner_github_id = _env("PROSER_OWNER_GITHUB_ID")
    if owner_github_id:
        payload["ownerGithubId"] = owner_github_id
    if email:
        payload["email"] = email

    signing_input = ".".join(
        [
            _base64url(json.dumps(header, separators=(",", ":")).encode("utf-8")),
            _base64url(json.dumps(payload, separators=(",", ":")).encode("utf-8")),
        ]
    )
    signature = hmac.new(secret.encode("utf-8"), signing_input.encode("ascii"), hashlib.sha256).digest()
    return f"{signing_input}.{_base64url(signature)}"


def _token() -> str:
    return _env("PROSER_TOKEN") or _sign_token()


def _timeout(args: dict[str, Any], method: str, path: str) -> float:
    streaming = path.endswith("/progress-stream")
    generation = method != "GET" and any(part in path for part in ("/generate", "/finalize", "/feedback", "/images", "/benchmarks", "/editorial-optimize"))
    default_name = "PROSER_STREAM_TIMEOUT_SECONDS" if streaming else "PROSER_GENERATION_TIMEOUT_SECONDS" if generation else "PROSER_READ_TIMEOUT_SECONDS"
    default_value = _env(default_name, "90" if streaming else "180" if generation else "30")
    value = args["timeoutSeconds"] if "timeoutSeconds" in args else default_value
    if isinstance(value, bool):
        raise ProserClientError("INVALID_TIMEOUT", "timeoutSeconds must be a finite number")
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        raise ProserClientError("INVALID_TIMEOUT", "timeoutSeconds must be a finite number") from None
    if not math.isfinite(parsed) or parsed <= 0:
        raise ProserClientError("INVALID_TIMEOUT", "timeoutSeconds must be a positive finite number")
    return min(600.0, parsed)


def _max_response_bytes() -> int:
    try:
        return max(1024, min(64 * 1024 * 1024, int(_env("PROSER_MAX_RESPONSE_BYTES", str(8 * 1024 * 1024)))))
    except ValueError:
        return 8 * 1024 * 1024


def _read_limited(response: Any) -> bytes:
    limit = _max_response_bytes()
    content_length = response.headers.get("Content-Length")
    if content_length:
        try:
            if int(content_length) > limit:
                raise ProserClientError("RESPONSE_TOO_LARGE", f"Proser response exceeds {limit} bytes")
        except ValueError:
            pass
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = response.read(min(65536, limit - size + 1))
        if not chunk:
            break
        size += len(chunk)
        if size > limit:
            raise ProserClientError("RESPONSE_TOO_LARGE", f"Proser response exceeds {limit} bytes")
        chunks.append(chunk)
    return b"".join(chunks)


class _SSEParser:
    """Incremental WHATWG-style SSE parser with bounded JSON event capture."""

    def __init__(self, on_event: Callable[[dict[str, Any]], None] | None = None):
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self._buffer = ""
        self._data: list[str] = []
        self._event = ""
        self._last_event_id = ""
        self._retry: int | None = None
        self._on_event = on_event
        self.events: list[Any] = []
        self.event_ids: list[str] = []
        self.checkpoint: dict[str, Any] = {}
        self.malformed_frames = 0

    def feed(self, chunk: bytes) -> None:
        self._buffer += self._decoder.decode(chunk)
        self._consume_lines(final=False)

    def finish(self) -> dict[str, Any]:
        self._buffer += self._decoder.decode(b"", final=True)
        self._consume_lines(final=True)
        self._dispatch()
        result: dict[str, Any] = {"events": self.events, **self.checkpoint}
        if self._last_event_id:
            result["lastEventId"] = self._last_event_id
        if self.event_ids:
            result["eventIds"] = self.event_ids
        if self.malformed_frames:
            result["malformedFrames"] = self.malformed_frames
        return result

    def _consume_lines(self, *, final: bool) -> None:
        while self._buffer:
            indexes = [index for index in (self._buffer.find("\n"), self._buffer.find("\r")) if index >= 0]
            if not indexes:
                if final:
                    line, self._buffer = self._buffer, ""
                    self._process_line(line)
                return
            index = min(indexes)
            if self._buffer[index] == "\r" and index + 1 == len(self._buffer) and not final:
                return
            line = self._buffer[:index]
            width = 2 if self._buffer[index:index + 2] == "\r\n" else 1
            self._buffer = self._buffer[index + width:]
            self._process_line(line)

    def _process_line(self, line: str) -> None:
        if line == "":
            self._dispatch()
            return
        if line.startswith(":"):
            return
        field, separator, value = line.partition(":")
        if separator and value.startswith(" "):
            value = value[1:]
        if field == "data":
            self._data.append(value)
        elif field == "event":
            self._event = value
        elif field == "id" and "\x00" not in value:
            self._last_event_id = value
        elif field == "retry":
            try:
                self._retry = int(value) if value.isdigit() else self._retry
            except ValueError:
                pass

    def _dispatch(self) -> None:
        if not self._data:
            self._event = ""
            self._retry = None
            return
        raw_data = "\n".join(self._data)
        frame = {"event": self._event or "message", "id": self._last_event_id, "data": raw_data, "retry": self._retry}
        self._data = []
        self._event = ""
        self._retry = None
        try:
            data = json.loads(raw_data)
        except json.JSONDecodeError:
            self.malformed_frames += 1
            return
        frame["data"] = data
        if self._on_event:
            self._on_event(frame)
        if frame["event"] == "checkpoint":
            if isinstance(data, dict):
                self.checkpoint.update(data)
            else:
                self.malformed_frames += 1
        else:
            self.events.append(data)
            self.event_ids.append(self._last_event_id)


def _read_sse(response: Any, on_event: Callable[[dict[str, Any]], None] | None = None) -> dict[str, Any]:
    limit = _max_response_bytes()
    content_length = response.headers.get("Content-Length")
    if content_length:
        try:
            if int(content_length) > limit:
                raise ProserClientError("RESPONSE_TOO_LARGE", f"Proser response exceeds {limit} bytes")
        except ValueError:
            pass
    parser = _SSEParser(on_event)
    size = 0
    while True:
        chunk = response.read(min(65536, limit - size + 1))
        if not chunk:
            break
        size += len(chunk)
        if size > limit:
            raise ProserClientError("RESPONSE_TOO_LARGE", f"Proser response exceeds {limit} bytes")
        parser.feed(chunk)
    return parser.finish()


def _parse_sse(text: str) -> dict[str, Any]:
    parser = _SSEParser()
    parser.feed(text.encode("utf-8"))
    return parser.finish()


def _urlopen(request: urllib.request.Request, timeout: float):
    context = None
    ca_file = _env("PROSER_CA_FILE")
    if request.full_url.lower().startswith("https://") and ca_file:
        context = ssl.create_default_context(cafile=ca_file)
    return urllib.request.urlopen(request, timeout=timeout, context=context)


def _require(args: dict[str, Any], name: str) -> Any:
    value = args.get(name)
    if value is None or value == "":
        raise ValueError(f"{name} is required for action '{args.get('action')}'")
    return value


def _query_string(query: Any) -> str:
    if not query:
        return ""
    if not isinstance(query, dict):
        raise ValueError("query must be an object")
    clean = {key: value for key, value in query.items() if value is not None}
    if not clean:
        return ""
    return "?" + urllib.parse.urlencode(clean, doseq=True)


def _body(args: dict[str, Any]) -> Any:
    body = args.get("body")
    if body is None:
        return None
    if not isinstance(body, dict):
        raise ValueError("body must be an object")
    return body


def _mutation_operation_id(body: Any, idempotency_key: str | None) -> Any:
    payload = body if isinstance(body, dict) else {}
    for candidate in (payload, payload.get("documentPreconditions"), payload.get("documentPreview")):
        if isinstance(candidate, dict) and candidate.get("operationId"):
            return candidate["operationId"]
    return idempotency_key


def _request(
    args: dict[str, Any],
    method: str,
    path: str,
    *,
    query: Any = None,
    body: Any = None,
    idempotency_key: str | None = None,
) -> str:
    managed = _NOVA_CLIENT.get()
    if managed is not None:
        headers = dict(_NOVA_HEADERS.get() or {})
        try:
            parsed = managed.json(method, path + _query_string(query), body, headers)
        except Exception as exc:
            # Legacy handlers return error envelopes. Retain the typed transport
            # result for Nova so a confirmed 4xx is not recorded as uncertain.
            _NOVA_FAILURE.set(exc)
            raise
        result = parsed.get('data') if isinstance(parsed, dict) and parsed.get('success') is True else parsed
        return _json({'ok': True, 'result': result, 'response': parsed})
    url = f"{_base_url()}{path}{_query_string(query)}"
    headers = {
        "Accept": "application/json",
        "User-Agent": "hermes-proser-api-plugin/1.0",
        "Authorization": f"Bearer {_token()}",
    }
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with _urlopen(request, timeout=_timeout(args, method, path)) as response:
            content_type = response.headers.get("Content-Type", "")
            if "text/event-stream" in content_type:
                parsed_sse = _read_sse(response)
                return _json({"ok": True, "status": response.status, "result": parsed_sse, "response": parsed_sse})
            raw = _read_limited(response)
            text = raw.decode("utf-8", errors="replace")
            if "application/json" in content_type:
                try:
                    parsed = json.loads(text) if text else None
                except json.JSONDecodeError as exc:
                    raise ProserClientError("MALFORMED_RESPONSE", "Proser returned malformed JSON") from exc
                result = parsed.get("data") if isinstance(parsed, dict) and parsed.get("success") is True and "data" in parsed else parsed
                # `result` is the stable agent-facing value. `response` remains
                # for one compatibility cycle for bundled helper scripts.
                return _json({"ok": True, "status": response.status, "result": result, "response": parsed})
            return _json(
                {
                    "ok": True,
                    "status": response.status,
                    "contentType": content_type,
                    "result": text,
                    "response": text,
                }
            )
    except urllib.error.HTTPError as exc:
        try:
            raw = _read_limited(exc)
        except ProserClientError as read_error:
            return _json({"ok": False, "status": exc.code, "error": {"code": read_error.code, "message": str(read_error), "retryable": False, "safeToRepeat": method in ("GET", "HEAD")}})
        text = raw.decode("utf-8", errors="replace")
        try:
            parsed: Any = json.loads(text) if text else None
        except json.JSONDecodeError:
            parsed = text
        error = parsed.get("error") if isinstance(parsed, dict) and "error" in parsed else parsed
        if isinstance(error, dict):
            details = error.get("details") if isinstance(error.get("details"), dict) else {}
            error.setdefault("retryable", bool(details.get("retryable", method in ("GET", "HEAD") and exc.code >= 500)))
            error.setdefault("safeToRepeat", bool(details.get("safeToRepeat", method in ("GET", "HEAD") and exc.code >= 500)))
            if exc.code in (409, 412, 428):
                error["retryable"] = False
                error["safeToRepeat"] = False
                error.setdefault("guidance", "Refresh the current source revision before launching a new idempotent operation.")
        return _json({"ok": False, "status": exc.code, "error": error})
    except ProserClientError as exc:
        return _json({"ok": False, "error": {"code": exc.code, "message": str(exc), "retryable": False, "safeToRepeat": method in ("GET", "HEAD"), **({"operationId": _mutation_operation_id(body, idempotency_key)} if method not in ("GET", "HEAD") else {})}})
    except Exception as exc:
        if method not in ("GET", "HEAD"):
            operation = _mutation_operation_id(body, idempotency_key)
            return _json({"ok": False, "error": {"code": "OPERATION_OUTCOME_UNKNOWN", "message": "Mutation acknowledgement was lost. Recover the retained operation before any retry.", "retryable": False, "safeToRepeat": False, "operationId": operation}})
        return _json({"ok": False, "error": str(exc)})


def _request_obj(args: dict[str, Any], method: str, path: str, *, query: Any = None, body: Any = None) -> dict[str, Any]:
    result = _request(args, method, path, query=query, body=body)
    parsed = json.loads(result)
    if not isinstance(parsed, dict):
        return {"ok": False, "error": "Unexpected non-object response from Proser"}
    return parsed


def _api_data(response: dict[str, Any]) -> Any:
    if not response.get("ok"):
        return response
    if "result" in response:
        return response.get("result")
    payload = response.get("response")
    if isinstance(payload, dict) and "data" in payload:
        return payload.get("data")
    return payload


def _truncate(value: Any, limit: int) -> str:
    text = "" if value is None else str(value)
    text = " ".join(text.split())
    if limit <= 0 or len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


def _word_count(value: Any) -> int:
    if not value:
        return 0
    return len(str(value).split())


def _int_option(query: Any, key: str, default: int, minimum: int = 1, maximum: int = 20000) -> int:
    if not isinstance(query, dict):
        return default
    try:
        value = int(query.get(key, default))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


def _scene_brief(scene: dict[str, Any], *, summary_chars: int, outline_chars: int, prose_chars: int) -> dict[str, Any]:
    prose = scene.get("prose") or ""
    brief: dict[str, Any] = {
        "id": scene.get("id"),
        "sceneNumber": scene.get("sceneNumber"),
        "chapterId": scene.get("chapterId"),
        "chapterNumber": scene.get("chapterNumber"),
        "chapterTitle": scene.get("chapterTitle"),
        "actId": scene.get("actId"),
        "actNumber": scene.get("actNumber"),
        "actTitle": scene.get("actTitle"),
        "wordCount": int(scene.get("wordCount") or 0) if "wordCount" in scene else _word_count(prose),
        "sourceBookRevisionId": scene.get("sourceBookRevisionId"),
        "sourceSceneRevisionId": scene.get("sourceSceneRevisionId"),
        "contentHash": scene.get("contentHash"),
        "projection": scene.get("projection"),
        "summary": _truncate(scene.get("summary"), summary_chars),
        "outline": _truncate(scene.get("outline"), outline_chars),
        "hasProse": bool(scene.get("hasProse")) if "hasProse" in scene else bool(prose.strip()),
    }
    if prose_chars > 0:
        brief["proseExcerpt"] = _truncate(prose, prose_chars)
    return brief


def _scenes_from_structure(data: Any) -> list[dict[str, Any]]:
    scenes: list[dict[str, Any]] = []
    acts = data.get("acts", []) if isinstance(data, dict) else []
    for act in acts:
        for chapter in act.get("chapters", []) or []:
            for scene in chapter.get("scenes", []) or []:
                item = dict(scene)
                item.setdefault("chapterId", chapter.get("id"))
                item.setdefault("chapterNumber", chapter.get("chapterNumber"))
                item.setdefault("chapterTitle", chapter.get("title"))
                item.setdefault("actId", act.get("id"))
                item.setdefault("actNumber", act.get("actNumber"))
                item.setdefault("actTitle", act.get("title"))
                scenes.append(item)
    return scenes


def proser_context(args: dict[str, Any], **kwargs: Any) -> str:
    del kwargs
    try:
        action = args.get("action")
        book_id = _require(args, "bookId")
        raw_query = args.get("query")
        query: dict[str, Any] = raw_query if isinstance(raw_query, dict) else {}
        summary_chars = _int_option(query, "maxSummaryChars", 220, 20, 4000)
        outline_chars = _int_option(query, "maxOutlineChars", 260, 20, 4000)
        prose_chars = _int_option(query, "maxProseChars", 0, 0, 8000)

        if action == "book_map":
            book_resp = _request_obj(args, "GET", f"/api/books/{book_id}", query={"includeProse": int(prose_chars > 0)})
            if not book_resp.get("ok"):
                return _json(book_resp)
            book = _api_data(book_resp)
            if not isinstance(book, dict):
                return _json({"ok": False, "error": "Unexpected book response"})
            scenes = _scenes_from_structure({"acts": book.get("acts", [])})
            compact_acts = []
            for act in book.get("acts", []) or []:
                compact_chapters = []
                for chapter in act.get("chapters", []) or []:
                    compact_scenes = []
                    for scene in chapter.get("scenes", []) or []:
                        enriched_scene = dict(scene)
                        enriched_scene.setdefault("chapterId", chapter.get("id"))
                        enriched_scene.setdefault("chapterNumber", chapter.get("chapterNumber"))
                        enriched_scene.setdefault("chapterTitle", chapter.get("title"))
                        enriched_scene.setdefault("actId", act.get("id"))
                        enriched_scene.setdefault("actNumber", act.get("actNumber"))
                        enriched_scene.setdefault("actTitle", act.get("title"))
                        compact_scenes.append(
                            _scene_brief(
                                enriched_scene,
                                summary_chars=summary_chars,
                                outline_chars=outline_chars,
                                prose_chars=prose_chars,
                            )
                        )
                    compact_chapters.append(
                        {
                            "id": chapter.get("id"),
                            "chapterNumber": chapter.get("chapterNumber"),
                            "title": chapter.get("title"),
                            "summary": _truncate(chapter.get("summary"), summary_chars),
                            "sceneCount": len(compact_scenes),
                            "wordCount": sum(int(scene.get("wordCount") or 0) for scene in compact_scenes),
                            "scenes": compact_scenes,
                        }
                    )
                compact_acts.append(
                    {
                        "id": act.get("id"),
                        "actNumber": act.get("actNumber"),
                        "title": act.get("title"),
                        "summary": _truncate(act.get("summary"), summary_chars),
                        "chapterCount": len(compact_chapters),
                        "wordCount": sum(int(chapter.get("wordCount") or 0) for chapter in compact_chapters),
                        "chapters": compact_chapters,
                    }
                )
            return _json(
                {
                    "ok": True,
                    "book": {
                        "id": book.get("id"),
                        "sourceBookRevisionId": book.get("sourceBookRevisionId"),
                        "projection": book.get("projection"),
                        "contentHash": book.get("contentHash"),
                        "title": book.get("title"),
                        "genre": book.get("genre"),
                        "targetAudience": book.get("targetAudience"),
                        "summary": _truncate(book.get("summary"), summary_chars),
                        "tagline": book.get("tagline"),
                    },
                    "totals": {
                        "acts": len(compact_acts),
                        "chapters": sum(len(act.get("chapters", [])) for act in compact_acts),
                        "scenes": len(scenes),
                        "words": sum(int(scene.get("wordCount") or 0) if "wordCount" in scene else _word_count(scene.get("prose")) for scene in scenes),
                    },
                    "acts": compact_acts,
                }
            )

        if action == "scene_brief":
            scene_id = int(_require(args, "sceneId"))
            scene_resp = _request_obj(args, "GET", f"/api/books/{book_id}/scenes/{scene_id}")
            if not scene_resp.get("ok"):
                return _json(scene_resp)
            data = _api_data(scene_resp)
            scene = data.get("scene") if isinstance(data, dict) else None
            if not isinstance(scene, dict):
                return _json({"ok": False, "error": f"Scene {scene_id} not found in book {book_id}"})
            return _json({"ok": True, "scene": _scene_brief(scene, summary_chars=summary_chars, outline_chars=outline_chars, prose_chars=prose_chars or 900)})

        if action == "codex_brief":
            page_size = _int_option(query, "pageSize", 50, 1, 100)
            codex_resp = _request_obj(args, "GET", f"/api/books/{book_id}/codex", query={**query, "pageSize": page_size})
            if not codex_resp.get("ok"):
                return _json(codex_resp)
            data = _api_data(codex_resp)
            entries = data.get("entries", []) if isinstance(data, dict) else []
            return _json(
                {
                    "ok": True,
                    "entries": [
                        {
                            "id": entry.get("id"),
                            "type": entry.get("entryType"),
                            "name": entry.get("entryName"),
                            "description": _truncate(entry.get("entryDescription"), summary_chars),
                        }
                        for entry in entries
                    ],
                    "pagination": data.get("pagination") if isinstance(data, dict) else None,
                }
            )

        if action == "search_scenes":
            needle = str(query.get("q") or query.get("search") or "").strip()
            if not needle:
                raise ValueError("query.q is required for search_scenes")
            limit = _int_option(query, "limit", 12, 1, 100)
            context_chars = _int_option(query, "contextChars", 180, 20, 1000)
            capabilities_resp = _request_obj(args, "GET", f"/api/books/{book_id}/document-capabilities")
            if not capabilities_resp.get("ok"):
                return _json(capabilities_resp)
            capabilities = _api_data(capabilities_resp)
            if not isinstance(capabilities, dict) or capabilities.get("schemaVersion") != 1 or not isinstance(capabilities.get("enabled"), bool):
                return _json({"ok": False, "status": 503, "error": {"code": "DOCUMENT_CAPABILITIES_UNAVAILABLE", "message": "Cannot negotiate an owned search source; no legacy full-prose read was attempted."}})
            if capabilities["enabled"]:
                if capabilities.get("globalSearch") != "manifest-cursor-v1" or capabilities.get("projection") != "final" or capabilities.get("searchIndex") != "revision-gin-v1":
                    return _json({"ok": False, "status": 503, "error": {"code": "DOCUMENT_SEARCH_CONTRACT_UNSUPPORTED", "message": "Factory does not advertise the supported revision-bound search contract."}})
                native_query = {"q": needle, "limit": limit, "caseSensitive": "1" if query.get("caseSensitive") in (True, 1, "1", "true") else "0"}
                if query.get("cursor"):
                    native_query["cursor"] = query["cursor"]
                found_resp = _request_obj(args, "GET", f"/api/books/{book_id}/document-search", query=native_query)
                if not found_resp.get("ok"):
                    return _json(found_resp)
                found = _api_data(found_resp)
                if not isinstance(found, dict) or found.get("schemaVersion") != 1 or found.get("projection") != "final" or not isinstance(found.get("hits"), list):
                    return _json({"ok": False, "error": {"code": "DOCUMENT_SEARCH_RESPONSE_INVALID", "message": "Factory returned an incompatible search response."}})
                hits = [{**hit, "id": hit.get("sceneId"), "matchId": hit.get("id"), "sourceBookRevisionId": found.get("sourceBookRevisionId"), "sourceSceneRevisionId": hit.get("sceneRevisionId"), "contentHash": hit.get("sceneContentHash"), "projection": "final", "hasProse": bool(hit.get("wordCount")), "matchExcerpt": hit.get("excerpt")} for hit in found["hits"] if isinstance(hit, dict)]
                return _json({"ok": True, "query": found.get("query"), "hitCount": len(hits), "hits": hits, "sourceBookRevisionId": found.get("sourceBookRevisionId"), "sourceContentHash": found.get("sourceContentHash"), "currentBookRevisionId": found.get("currentBookRevisionId"), "stale": found.get("stale"), "complete": found.get("complete"), "nextCursor": found.get("nextCursor"), "scannedScenes": found.get("scannedScenes"), "index": found.get("index")})
            scenes_resp = _request_obj(args, "GET", f"/api/books/{book_id}/scenes")
            if not scenes_resp.get("ok"):
                return _json(scenes_resp)
            data = _api_data(scenes_resp)
            scenes = data.get("scenes", []) if isinstance(data, dict) else []
            hits = []
            needle_l = needle.lower()
            for scene in scenes:
                haystack = str(scene.get("prose") or "")
                idx = haystack.lower().find(needle_l)
                if idx < 0:
                    continue
                start = max(0, idx - context_chars)
                end = min(len(haystack), idx + len(needle) + context_chars)
                excerpt = haystack[start:end].strip()
                if start > 0:
                    excerpt = "…" + excerpt
                if end < len(haystack):
                    excerpt += "…"
                hit = _scene_brief(scene, summary_chars=summary_chars, outline_chars=outline_chars, prose_chars=0)
                hit["matchExcerpt"] = " ".join(excerpt.split())
                hits.append(hit)
                if len(hits) >= limit:
                    break
            return _json({"ok": True, "query": needle, "hitCount": len(hits), "hits": hits})

        return _json({"ok": False, "error": f"Unsupported proser_context action: {action}"})
    except Exception as exc:
        return _json({"ok": False, "error": str(exc)})


def proser_books(args: dict[str, Any], **kwargs: Any) -> str:
    del kwargs
    try:
        action = args.get("action")
        body = _body(args)
        idem = args.get("idempotencyKey")

        document_routes = {
            "document_capabilities": ("GET", "document-capabilities"),
            "document_manifest": ("GET", "document-manifest"),
            "scene_document": ("GET", f"scenes/{args.get('sceneId')}/document"),
            "scene_comments": ("GET", f"scenes/{args.get('sceneId')}/document-comments"),
            "revalidate_scene_comment": ("POST", f"scenes/{args.get('sceneId')}/document-comments/{args.get('commentId')}/revalidate"),
            "resolve_scene_comment": ("POST", f"scenes/{args.get('sceneId')}/document-comments/{args.get('commentId')}/resolve"),
            "layout_story_comments": ("GET", f"layout-stories/{args.get('storyId')}/document-comments"),
            "revalidate_layout_story_comment": ("POST", f"layout-stories/{args.get('storyId')}/document-comments/{args.get('commentId')}/revalidate"),
            "resolve_layout_story_comment": ("POST", f"layout-stories/{args.get('storyId')}/document-comments/{args.get('commentId')}/resolve"),
            "document_scope": ("GET", f"document-scopes/{args.get('scope')}"),
            "document_commit": ("POST", "document-commits"),
            "document_layout_commit": ("POST", "document-layout-commits"),
            "document_operation": ("GET", f"document-operations/{args.get('operationId')}"),
            "document_inference_operation": ("GET", f"document-inference-operations/{args.get('operationId')}"),
            "cancel_document_inference_operation": ("POST", f"document-inference-operations/{args.get('operationId')}/cancel"),
            "create_document_discussion": ("POST", "document-discussions"),
            "document_discussion": ("GET", f"document-discussions/{args.get('discussionId')}"),
            "discussion_proposals": ("GET", f"document-discussions/{args.get('discussionId')}/proposals"),
            "request_document_proposal": ("POST", f"document-discussions/{args.get('discussionId')}/proposals"),
            "document_proposal": ("GET", f"document-proposals/{args.get('proposalId')}"),
            "cancel_document_proposal": ("POST", f"document-proposals/{args.get('proposalId')}/cancel"),
            "revalidate_document_proposal": ("POST", f"document-proposals/{args.get('proposalId')}/revalidate"),
            "apply_document_proposal": ("POST", f"document-proposals/{args.get('proposalId')}/apply"),
            "document_restore": ("POST", f"document-revisions/{args.get('revisionId')}/restore"),
            "operator_operations": ("GET", "document-operator-effects"),
            "operator_operation": ("GET", f"document-operator-effects/{args.get('operationId')}"),
            "cancel_operator_operation": ("POST", f"document-operator-effects/{args.get('operationId')}/cancel"),
        }
        if action in document_routes:
            method, suffix = document_routes[action]
            if action in ("scene_document", "scene_comments", "revalidate_scene_comment", "resolve_scene_comment"): _require(args, "sceneId")
            if action in ("layout_story_comments", "revalidate_layout_story_comment", "resolve_layout_story_comment"): _require(args, "storyId")
            if action in ("revalidate_scene_comment", "resolve_scene_comment", "revalidate_layout_story_comment", "resolve_layout_story_comment"): _require(args, "commentId")
            if action == "document_scope":
                if args.get("scope") not in ("structure", "canon", "layout"): raise ValueError("scope must be structure, canon or layout")
            if action in ("document_operation", "document_inference_operation", "cancel_document_inference_operation", "operator_operation", "cancel_operator_operation"): _require(args, "operationId")
            if action == "document_restore": _require(args, "revisionId")
            if action in ("document_discussion", "discussion_proposals", "request_document_proposal"): _require(args, "discussionId")
            if action in ("document_proposal", "cancel_document_proposal", "revalidate_document_proposal", "apply_document_proposal"): _require(args, "proposalId")
            return _request(args, method, f"/api/books/{_require(args, 'bookId')}/{suffix}", body=(body or {}) if method == "POST" else None, query=args.get("query") if method == "GET" else None)

        if action == "list_books":
            return _request(args, "GET", "/api/books", query=args.get("query"))
        if action == "get_book":
            return _request(args, "GET", f"/api/books/{_require(args, 'bookId')}", query={"includeProse": 1, **(args.get("query") or {})})
        if action == "create_book":
            return _request(args, "POST", "/api/books", body=body or {}, idempotency_key=idem)
        if action == "update_book":
            return _request(args, "PUT", f"/api/books/{_require(args, 'bookId')}", body=body or {})
        if action == "delete_book":
            return _request(args, "DELETE", f"/api/books/{_require(args, 'bookId')}", body=body)
        if action == "get_structure":
            return _request(args, "GET", f"/api/books/{_require(args, 'bookId')}/structure")
        if action == "save_structure":
            return _request(args, "POST", f"/api/books/{_require(args, 'bookId')}/structure", body=body or {})
        if action == "create_act":
            return _request(args, "POST", f"/api/books/{_require(args, 'bookId')}/acts", body=body or {})
        if action == "update_act":
            return _request(args, "PUT", f"/api/books/{_require(args, 'bookId')}/acts/{_require(args, 'actId')}", body=body or {})
        if action == "delete_act":
            return _request(args, "DELETE", f"/api/books/{_require(args, 'bookId')}/acts/{_require(args, 'actId')}", body=body)
        if action == "create_chapter":
            return _request(args, "POST", f"/api/books/{_require(args, 'bookId')}/acts/{_require(args, 'actId')}/chapters", body=body or {})
        if action == "update_chapter":
            return _request(args, "PUT", f"/api/books/{_require(args, 'bookId')}/chapters/{_require(args, 'chapterId')}", body=body or {})
        if action == "delete_chapter":
            return _request(args, "DELETE", f"/api/books/{_require(args, 'bookId')}/chapters/{_require(args, 'chapterId')}", body=body)
        if action == "list_scenes":
            return _request(args, "GET", f"/api/books/{_require(args, 'bookId')}/scenes", query=args.get("query"))
        if action == "list_chapter_scenes":
            return _request(args, "GET", f"/api/books/{_require(args, 'bookId')}/chapters/{_require(args, 'chapterId')}/scenes", query=args.get("query"))
        if action == "get_scene":
            return _request(args, "GET", f"/api/books/{_require(args, 'bookId')}/scenes/{_require(args, 'sceneId')}")
        if action == "create_scene":
            return _request(args, "POST", f"/api/books/{_require(args, 'bookId')}/chapters/{_require(args, 'chapterId')}/scenes", body=body or {})
        if action == "update_scene":
            return _request(args, "PUT", f"/api/books/{_require(args, 'bookId')}/scenes/{_require(args, 'sceneId')}", body=body or {})
        if action == "delete_scene":
            return _request(args, "DELETE", f"/api/books/{_require(args, 'bookId')}/scenes/{_require(args, 'sceneId')}", body=body)
        if action == "regenerate_scene":
            return _request(args, "POST", f"/api/books/{_require(args, 'bookId')}/scenes/{_require(args, 'sceneId')}/regenerate", body=body)
        if action == "latest_scene_trace":
            return _request(args, "GET", f"/api/books/{_require(args, 'bookId')}/scenes/{_require(args, 'sceneId')}/prose/traces/latest")
        if action == "submit_prose_preference":
            return _request(args, "POST", f"/api/books/{_require(args, 'bookId')}/scenes/{_require(args, 'sceneId')}/prose/preferences", body=body or {})
        if action == "list_notes":
            return _request(args, "GET", f"/api/books/{_require(args, 'bookId')}/notes", query=args.get("query"))
        if action == "create_note":
            return _request(args, "POST", f"/api/books/{_require(args, 'bookId')}/notes", body=body or {})
        if action == "update_note":
            return _request(args, "PUT", f"/api/books/{_require(args, 'bookId')}/notes/{_require(args, 'noteId')}", body=body or {})
        if action == "delete_note":
            return _request(args, "DELETE", f"/api/books/{_require(args, 'bookId')}/notes/{_require(args, 'noteId')}")
        if action == "export_book":
            return _request(args, "GET", f"/api/books/{_require(args, 'bookId')}/export", query=args.get("query"))
            return _request(args, "GET", f"/api/books/{_require(args, 'bookId')}/prose/quality")
        return _json({"ok": False, "error": f"Unsupported proser_books action: {action}"})
    except Exception as exc:
        return _json({"ok": False, "error": str(exc)})


def proser_exports(args: dict[str, Any], **kwargs: Any) -> str:
    del kwargs
    try:
        action = args.get("action")
        book_id = _require(args, "bookId")
        if action == "capabilities":
            return _request(args, "GET", f"/api/books/{book_id}/document-publication-capabilities")
        if action == "get_job":
            return _request(args, "GET", f"/api/books/{book_id}/document-publication-jobs/{_require(args, 'jobId')}")
        if action == "create_file":
            return _request(args, "POST", f"/api/books/{book_id}/export-artifacts", body=_body(args) or {})
        artifact_id = _require(args, "artifactId")
        base = f"/api/books/{book_id}/export-artifacts/{artifact_id}"
        if action == "get_file":
            return _request(args, "GET", base)
        if action == "read_file":
            return _request(args, "GET", f"{base}/read", query=args.get("query"))
        if action == "delete_file":
            return _request(args, "DELETE", base)
        return _json({"ok": False, "error": f"Unsupported proser_exports action: {action}"})
    except Exception as exc:
        return _json({"ok": False, "error": str(exc)})




def proser_codex(args: dict[str, Any], **kwargs: Any) -> str:
    del kwargs
    try:
        action = args.get("action")
        body = _body(args)
        if action == "list_entries":
            return _request(args, "GET", f"/api/books/{_require(args, 'bookId')}/codex", query=args.get("query"))
        if action == "search":
            return _request(args, "GET", f"/api/books/{_require(args, 'bookId')}/codex/search", query=args.get("query"))
        if action == "create_entry":
            return _request(args, "POST", f"/api/books/{_require(args, 'bookId')}/codex", body=body or {})
        if action == "get_entry":
            return _request(args, "GET", f"/api/codex/{_require(args, 'codexId')}")
        if action == "update_entry":
            return _request(args, "PUT", f"/api/codex/{_require(args, 'codexId')}", body=body or {})
        if action == "delete_entry":
            return _request(args, "DELETE", f"/api/codex/{_require(args, 'codexId')}", body=body)
        return _json({"ok": False, "error": f"Unsupported proser_codex action: {action}"})
    except Exception as exc:
        return _json({"ok": False, "error": str(exc)})


def proser_generate(args: dict[str, Any], **kwargs: Any) -> str:
    del kwargs
    try:
        action = args.get("action")
        body = _body(args)
        if body is None:
            raise ValueError("body is required for generation actions")
        idem = args.get("idempotencyKey")
        paths = {
            "character": "/api/generate/character",
            "location": "/api/generate/location",
            "item": "/api/generate/item",
            "codex": "/api/generate/codex",
            "outline": "/api/generate/outline",
            "summary": "/api/generate/summary",
            "title": "/api/generate/title",
            "tagline": "/api/generate/tagline",
            "inline_suggestion": "/api/generate/inline-suggestion",
            "feedback": "/api/generate/feedback",
            "structure": "/api/generate/structure",
            "prose": "/api/generate/prose",
            "batch_prose": "/api/generate/prose/batch",
            "revise_prose": "/api/generate/prose/revise",
            "command_revise": "/api/generate/prose/command-revise",
        }
        path = paths.get(str(action))
        if not path:
            return _json({"ok": False, "error": f"Unsupported proser_generate action: {action}"})
        if action in ("revise_prose", "command_revise", "inline_suggestion", "feedback"):
            book_id = body.get("bookId")
            if not isinstance(book_id, int) or isinstance(book_id, bool) or book_id < 1:
                return _json({"ok": False, "error": {"code": "DOCUMENT_BOOK_REQUIRED", "message": "Revision previews require an owned bookId.", "retryable": False, "safeToRepeat": True}})
            capabilities = _request_obj(args, "GET", f"/api/books/{book_id}/document-capabilities")
            if not capabilities.get("ok"):
                return _json(capabilities)
            capability = _api_data(capabilities)
            if not isinstance(capability, dict) or capability.get("schemaVersion") != 1 or type(capability.get("enabled")) is not bool:
                return _json({"ok": False, "error": {"code": "DOCUMENT_CAPABILITIES_UNAVAILABLE", "message": "Document capabilities could not be verified; no inference was started.", "retryable": False, "safeToRepeat": True}})
            preview = body.get("documentPreview")
            if capability["enabled"]:
                if capability.get("revisionPreview") != "disclosed-proposal-v1" or capability.get("revisionSource") != "immutable-manifest-v1" or capability.get("projection") != "final":
                    return _json({"ok": False, "error": {"code": "DOCUMENT_PREVIEW_CONTRACT_UNSUPPORTED", "message": "The active Factory does not advertise the disclosed proposal preview contract; no inference was started.", "retryable": False, "safeToRepeat": True}})
                if not isinstance(preview, dict) or not preview.get("discussionId") or not preview.get("operationId") or not isinstance(body.get("sceneId"), int) or isinstance(body.get("sceneId"), bool) or body["sceneId"] < 1:
                    return _json({"ok": False, "status": 428, "error": {"code": "DOCUMENT_PRECONDITION_REQUIRED", "message": "Create and disclose a revision-bound document discussion first, then supply sceneId and documentPreview {discussionId, operationId}. Arbitrary originalText does not authorize inference.", "retryable": False, "safeToRepeat": True}})
            elif preview is not None:
                return _json({"ok": False, "status": 503, "error": {"code": "DOCUMENT_AUTHORITY_INACTIVE", "message": "Structured revision previews are inactive; no inference was started.", "retryable": False, "safeToRepeat": True}})
        return _request(args, "POST", path, body=body, idempotency_key=idem)
    except Exception as exc:
        return _json({"ok": False, "error": str(exc)})
























def _recommendations(args: dict[str, Any]) -> list[str]:
    try: value = json.loads(str(_require(args, "recommendationsJson")))
    except json.JSONDecodeError as exc: raise ValueError("recommendationsJson must be valid JSON") from exc
    if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value):
        raise ValueError("recommendationsJson must be an array of non-empty strings")
    return value










def proser_settings(args: dict[str, Any], **kwargs: Any) -> str:
    del kwargs
    try:
        action = args.get("action")
        body = _body(args)
        if action == "get":
            return _request(args, "GET", "/api/settings")
        if action == "update":
            return _request(args, "PUT", "/api/settings", body=body or {})
        return _json({"ok": False, "error": f"Unsupported proser_settings action: {action}"})
    except Exception as exc:
        return _json({"ok": False, "error": str(exc)})


def proser_models(args: dict[str, Any], **kwargs: Any) -> str:
    del kwargs
    try:
        action = args.get("action")
        if action == "list":
            return _request(args, "GET", "/api/models")
        if action == "status":
            return _request(args, "GET", "/api/models/status")
        return _json({"ok": False, "error": f"Unsupported proser_models action: {action}"})
    except Exception as exc:
        return _json({"ok": False, "error": str(exc)})


def proser_images(args: dict[str, Any], **kwargs: Any) -> str:
    del kwargs
    try:
        action = args.get("action")
        body = _body(args)
        idem = args.get("idempotencyKey")
        if action == "health":
            return _request(args, "GET", "/api/images/health")
        if action == "list":
            return _request(args, "GET", "/api/images/list", query=args.get("query"))
        if action == "suggest_prompt":
            return _request(args, "POST", "/api/images/suggest-prompt", body=body or {}, idempotency_key=idem)
        if action == "generate":
            return _request(args, "POST", "/api/images/generate", body=body or {}, idempotency_key=idem)
        if action == "generate_flux":
            return _request(args, "POST", "/api/images/generate/flux", body=body or {}, idempotency_key=idem)
        return _json({"ok": False, "error": f"Unsupported proser_images action: {action}"})
    except Exception as exc:
        return _json({"ok": False, "error": str(exc)})










def _artifact_payload(args: dict[str, Any]) -> dict[str, Any]:
    if "payloadJson" in args:
        try:
            payload = json.loads(str(args["payloadJson"]))
        except json.JSONDecodeError as exc:
            raise ValueError(f"payloadJson must be valid JSON: {exc.msg}") from exc
        if not isinstance(payload, dict):
            raise ValueError("payloadJson must decode to a JSON object")
        return payload
    payload = _require(args, "payload")
    if not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object")
    return payload














def _workflow_scope(args: dict[str, Any]) -> dict[str, Any]:
    scope_type = str(args.get("scopeType", "book"))
    scope: dict[str, Any] = {"type": scope_type}
    if "scopeId" in args:
        scope["id"] = args["scopeId"]
    if scope_type != "book" and "id" not in scope:
        raise ValueError("scopeId is required when scopeType is not book")
    return scope


def proser_full_book(args: dict[str, Any], **kwargs: Any) -> str:
    del kwargs
    body = {key: value for key, value in args.items() if key not in {"timeoutSeconds", "idempotencyKey"}}
    return _request(args, "POST", "/api/workflows/full-book", body=body, idempotency_key=_require(args, "idempotencyKey"))


def proser_quality_review_v1(args: dict[str, Any], **kwargs: Any) -> str:
    del kwargs
    body = {"bookId": _require(args, "bookId"), "model": _require(args, "model"), "rubricVersion": args.get("rubricVersion", "publishable-v1"), "scope": _workflow_scope(args)}
    return _request(args, "POST", "/api/workflows/quality-review", body=body, idempotency_key=_require(args, "idempotencyKey"))


def proser_improve_quality(args: dict[str, Any], **kwargs: Any) -> str:
    del kwargs
    body = {key: args[key] for key in ("bookId", "reviewRunIds", "findingIds", "model") if key in args}
    return _request(args, "POST", "/api/workflows/improve-quality", body=body, idempotency_key=_require(args, "idempotencyKey"))


def proser_guided_improve(args: dict[str, Any], **kwargs: Any) -> str:
    del kwargs
    body = {key: args[key] for key in ("bookId", "instruction", "model", "acceptanceCriteria") if key in args}
    body["scope"] = _workflow_scope(args)
    return _request(args, "POST", "/api/workflows/guided-improve", body=body, idempotency_key=_require(args, "idempotencyKey"))


def proser_workflow_status(args: dict[str, Any], **kwargs: Any) -> str:
    del kwargs
    return _request(args, "GET", f"/api/workflows/{_require(args, 'runId')}")


def _workflow_control(args: dict[str, Any], action: str) -> str:
    return _request(args, "POST", f"/api/workflows/{_require(args, 'runId')}/{action}", body={})


def proser_workflow_pause(args: dict[str, Any], **kwargs: Any) -> str:
    del kwargs
    return _workflow_control(args, "pause")


def proser_workflow_resume(args: dict[str, Any], **kwargs: Any) -> str:
    del kwargs
    return _workflow_control(args, "resume")


def proser_workflow_cancel(args: dict[str, Any], **kwargs: Any) -> str:
    del kwargs
    return _workflow_control(args, "cancel")


def proser_workflow_checkpoint(args: dict[str, Any], **kwargs: Any) -> str:
    del kwargs
    run_id = _require(args, "runId")
    checkpoint_id = _require(args, "checkpointId")
    body = {"decision": _require(args, "decision")}
    if "reason" in args: body["reason"] = args["reason"]
    return _request(args, "POST", f"/api/workflows/{run_id}/checkpoints/{checkpoint_id}/decision", body=body)


def proser_publication(args: dict[str, Any], **kwargs: Any) -> str:
    del kwargs
    return _request(args, "GET", f"/api/workflows/{_require(args, 'runId')}/publication")


def proser_editorial_optimize(args: dict[str, Any], **kwargs: Any) -> str:
    """Launch one checkpoint-free editorial workflow and return immediately on 202."""
    del kwargs
    body = {
        key: args[key]
        for key in ("bookId", "objective", "passPack", "autonomy", "profileId", "protectedElements", "changeBudget", "modelPolicy")
        if key in args
    }
    body["scope"] = _workflow_scope(args)
    return _request(
        args, "POST", "/api/workflows/editorial-optimize", body=body,
        idempotency_key=_require(args, "idempotencyKey"),
    )


def proser_editorial(args: dict[str, Any], **kwargs: Any) -> str:
    """Bounded editorial evidence, feedback, proposal, and benchmark actions."""
    del kwargs
    action = str(_require(args, "action"))
    if action == "list_passes":
        return _request(args, "GET", "/api/editorial/pass-packs")
    if action == "resolve_profile":
        return _request(args, "GET", f"/api/books/{_require(args, 'bookId')}/editorial-profile/resolved")
    if action == "run_summary":
        return _request(args, "GET", f"/api/editorial/runs/{_require(args, 'runId')}/summary")
    if action == "list_proposals":
        return _request(args, "GET", f"/api/editorial/runs/{_require(args, 'runId')}/proposals", query=args.get("query"))
    if action == "get_proposal":
        proposal_id = _require(args, "proposalId")
        run_id = _require(args, "runId")
        return _request(args, "GET", f"/api/editorial/runs/{run_id}/proposals/{proposal_id}")
    if action == "record_preference":
        body = {"evidenceType": _require(args, "evidenceType")}
        if "candidateId" in args: body["candidateId"] = args["candidateId"]
        if "rationaleTags" in args: body["rationaleTags"] = args["rationaleTags"]
        return _request(args, "POST", f"/api/editorial/proposals/{_require(args, 'proposalId')}/preference", body=body)
    if action == "apply_proposal":
        return _request(args, "POST", f"/api/editorial/proposals/{_require(args, 'proposalId')}/apply", body={"candidateId": _require(args, "candidateId")})
    if action == "run_benchmark":
        body = {key: args[key] for key in ("suiteKey", "live", "maximumCases") if key in args}
        if "passPack" in args: body["passKey"] = args["passPack"]
        return _request(args, "POST", "/api/editorial/benchmarks", body=body, idempotency_key=_require(args, "idempotencyKey"))
    if action == "benchmark_status":
        return _request(args, "GET", f"/api/editorial/benchmarks/{_require(args, 'benchmarkRunId')}")
    if action == "benchmark_report":
        return _request(args, "GET", f"/api/editorial/benchmarks/{_require(args, 'benchmarkRunId')}/report")
    return _json({"ok": False, "status": 400, "error": {"code": "EDITORIAL_ACTION_INVALID", "message": f"Unsupported editorial action: {action}", "safeToRepeat": True}})
