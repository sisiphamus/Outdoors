// Redirector — chiefton's original Codex-CLI runner has been replaced by
// the Claude-powered runner. Everything that imports runModel still gets
// the same signature and return shape; under the hood it now goes through
// the outdoors-chat proxy → Anthropic API, with local tool dispatch.
//
// Keep this file as the canonical import site so orchestrator.js and any
// external callers don't need to know about the swap.

export { runModel, checkCodexAuthValidity } from './claude-model-runner.js';
