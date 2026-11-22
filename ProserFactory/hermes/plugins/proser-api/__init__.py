"""Hermes plugin registration for scoped ProserFactory API access."""

# pyright: strict

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType
from typing import Callable, Mapping, Protocol


ToolHandler = Callable[..., str]


class PluginContext(Protocol):
    """Hermes registration surface used by this plugin."""

    def register_tool(
        self,
        *,
        name: str,
        toolset: str,
        schema: Mapping[str, object],
        handler: ToolHandler,
        description: str,
    ) -> None: ...

    def register_skill(self, *, name: str, path: str) -> None: ...


_PLUGIN_DIR = Path(__file__).parent


def _load_module(name: str, filename: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, _PLUGIN_DIR / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {filename}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


schemas = _load_module("_proser_api_schemas", "schemas.py")
tools = _load_module("_proser_api_tools", "tools.py")


def register(ctx: PluginContext) -> None:
    """Register the Proser tool subset with Hermes."""
    from hermes_constants import get_hermes_home
    managed = (Path(get_hermes_home()) / 'nova-creative.json').exists()
    if managed:
        from .nova_support import ManagedContext, register_extra
        ctx = ManagedContext(ctx, tools)
        register_extra(ctx, tools)


    ctx.register_tool(
        name="proser_books",
        toolset="proser_api",
        schema=schemas.PROSER_BOOKS,
        handler=tools.proser_books,
        description="Call scoped Proser book, structure, scene, note, and export endpoints.",
    )
    ctx.register_tool(
        name="proser_exports",
        toolset="proser_api",
        schema=schemas.PROSER_EXPORTS,
        handler=tools.proser_exports,
        description="Create metadata-only Markdown export artifacts and read bounded book, chapter, or scene selections.",
    )
    ctx.register_tool(
        name="proser_codex",
        toolset="proser_api",
        schema=schemas.PROSER_CODEX,
        handler=tools.proser_codex,
        description="Call scoped Proser codex list, search, create, update, and delete endpoints.",
    )
    ctx.register_tool(
        name="proser_context",
        toolset="proser_api",
        schema=schemas.PROSER_CONTEXT,
        handler=tools.proser_context,
        description="Call compact read-only Proser context endpoints for book maps, scene briefs, codex briefs, and search hits.",
    )
    ctx.register_tool(
        name="proser_generate",
        toolset="proser_api",
        schema=schemas.PROSER_GENERATE,
        handler=tools.proser_generate,
        description="Call scoped Proser generation endpoints for codex, outlines, summaries, and prose.",
    )
    ctx.register_tool(
        name="proser_settings",
        toolset="proser_api",
        schema=schemas.PROSER_SETTINGS,
        handler=tools.proser_settings,
        description="Call scoped Proser per-user settings endpoints for the Hermes profile.",
    )
    ctx.register_tool(
        name="proser_models",
        toolset="proser_api",
        schema=schemas.PROSER_MODELS,
        handler=tools.proser_models,
        description="Call scoped Proser model listing, status, and inference-settings endpoints.",
    )
    ctx.register_tool(
        name="proser_images",
        toolset="proser_api",
        schema=schemas.PROSER_IMAGES,
        handler=tools.proser_images,
        description="Call scoped Proser image health, prompt suggestion, listing, and generation endpoints.",
    )
    for name, schema, handler, description in (
        ("proser_full_book", schemas.PROSER_FULL_BOOK, tools.proser_full_book, "Start end-to-end book creation with integrated review and improvement."),
        ("proser_quality_review", schemas.PROSER_QUALITY_REVIEW_V1, tools.proser_quality_review_v1, "Start one immutable read-only model review round."),
        ("proser_improve_quality", schemas.PROSER_IMPROVE_QUALITY, tools.proser_improve_quality, "Implement selected stored quality findings."),
        ("proser_guided_improve", schemas.PROSER_GUIDED_IMPROVE, tools.proser_guided_improve, "Apply a general author instruction with safety checkpoints."),
        ("proser_editorial_optimize", schemas.PROSER_EDITORIAL_OPTIMIZE, tools.proser_editorial_optimize, "Start one autonomous, checkpoint-free editorial workflow."),
        ("proser_editorial", schemas.PROSER_EDITORIAL, tools.proser_editorial, "Read bounded editorial evidence and Quality Lab results or record optional preferences."),
        ("proser_workflow_status", schemas.PROSER_WORKFLOW_STATUS, tools.proser_workflow_status, "Read compact workflow progress."),
        ("proser_workflow_checkpoint", schemas.PROSER_WORKFLOW_CHECKPOINT, tools.proser_workflow_checkpoint, "Decide a pending author checkpoint."),
        ("proser_workflow_pause", schemas.PROSER_WORKFLOW_PAUSE, tools.proser_workflow_pause, "Pause a workflow."),
        ("proser_workflow_resume", schemas.PROSER_WORKFLOW_RESUME, tools.proser_workflow_resume, "Resume a workflow."),
        ("proser_workflow_cancel", schemas.PROSER_WORKFLOW_CANCEL, tools.proser_workflow_cancel, "Cancel a workflow."),
        ("proser_publication", schemas.PROSER_PUBLICATION, tools.proser_publication, "Read publication gates and artifacts."),
    ):
        ctx.register_tool(name=name, toolset="proser_api", schema=schema, handler=handler, description=description)

    skill_dir = _PLUGIN_DIR / "skills" / "proser-authoring"
    if hasattr(ctx, "register_skill") and skill_dir.exists():
        ctx.register_skill(name="proser-authoring", path=skill_dir)

    codex_entry_skill_dir = _PLUGIN_DIR / "skills" / "proser-codex-entry-designer"
    if hasattr(ctx, "register_skill") and codex_entry_skill_dir.exists():
        ctx.register_skill(name="proser-codex-entry-designer", path=codex_entry_skill_dir)

    reader_skill_dir = _PLUGIN_DIR / "skills" / "proser-book-reader"
    if hasattr(ctx, "register_skill") and reader_skill_dir.exists():
        ctx.register_skill(name="proser-book-reader", path=reader_skill_dir)

    workflow_skill_dir = _PLUGIN_DIR / "skills" / "proser-workflows"
    if hasattr(ctx, "register_skill") and workflow_skill_dir.exists():
        ctx.register_skill(name="proser-workflows", path=workflow_skill_dir)

    editorial_skill_dir = _PLUGIN_DIR / "skills" / "proser-editorial"
    if hasattr(ctx, "register_skill") and editorial_skill_dir.exists():
        ctx.register_skill(name="proser-editorial", path=editorial_skill_dir)
