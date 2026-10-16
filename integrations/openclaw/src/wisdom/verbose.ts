/**
 * verbose.ts — OpenClaw wiring for Intuitive Wisdom verbose mode (spec
 * docs/superpowers/specs/2026-10-16-wisdom-verbose-mode-design.md, D3/D4).
 *
 * The user-only channel is the plugin logger (`api.logger.info`), which lands
 * in the gateway log (`openclaw logs --follow`). No in-chat surface is used:
 * every one OpenClaw offers a plugin either becomes model context or edits the
 * reply the model reads back. The record goes to
 * $OPENCLAW_STATE_DIR/logs/ct-wisdom-verbose.jsonl (default ~/.openclaw).
 */

import {
  createVerboseRecorder,
  defaultVerboseLogPath,
  type VerboseTurn,
} from '@equational-applications/ct-wisdom-core';
import type { OpenClawApiLike } from '../host.js';

export function openclawVerboseRecorder(
  api: Pick<OpenClawApiLike, 'logger'>,
  env: NodeJS.ProcessEnv,
): ((turn: VerboseTurn) => void) | undefined {
  return createVerboseRecorder({
    host: 'openclaw',
    channel: 'before_prompt_build',
    env,
    logPath: defaultVerboseLogPath('openclaw', env),
    notify: (text) => api.logger?.info?.(`curated-thoughts: ${text}`),
  });
}
