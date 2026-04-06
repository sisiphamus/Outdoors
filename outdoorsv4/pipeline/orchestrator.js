// Pipeline orchestrator — coordinates A → B → C? → D → learn with feedback loops.

import { runModel } from './model-runner.js';
import { ensureBrowserReady } from '../../outdoorsv1/backend/src/browser-health.js';
import { runPhaseA, runPhaseB } from './ml-runner.js';
import { buildGapPrompt as modelBGapPrompt } from './prompts/model-b.js';
import { buildPrompt as modelCPrompt } from './prompts/model-c.js';
import { buildPrompt as modelDPrompt } from './prompts/model-d.js';
import { buildPrompt as learnerPrompt } from './prompts/learner.js';
import { parseOutputSpec, parseAuditResult, parseTeacherResult, parseLearnerResult } from '../util/output-parser.js';
import { createAggregator } from '../util/progress-aggregator.js';
import { getFullInventory, getContents, writeMemory, updateMemory, detectSiteContext, MEMORY_ROOT } from '../memory/memory-manager.js';
import { config } from '../config.js';
import { setClaudeSessionId } from '../session/session-manager.js';
import { redactSecrets } from './redact-secrets.js';
import { execSync, execFileSync } from 'child_process';
import { mkdirSync, readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const MAX_FEEDBACK_LOOPS = 3;

const FAILURE_PATTERNS = [
  /i (?:can'?t|cannot|am unable to|don'?t have (?:the ability|access)|am not able to) (?:do|perform|complete|accomplish|execute|help with)/i,
  /(?:unfortunately|sorry),? (?:i |this )?(?:can'?t|cannot|isn'?t possible|is not possible|won'?t work)/i,
  /i don'?t (?:know how|have (?:enough|the (?:tools|knowledge|capability)))/i,
  /(?:beyond|outside) (?:my|the) (?:capabilities|scope|ability)/i,
  /not (?:currently )?(?:able|possible|supported)/i,
  /i'?m (?:afraid|sorry) (?:i |that )?(?:can'?t|cannot)/i,
  /(?:404|page not found|server error|cannot be displayed|error loading)/i,
];

const SUCCESS_PATTERNS = [
  /^(?:all )?done\.?$/i,
  /^(?:all )?complete[d.]?\.?$/i,
  /^(?:task )?(?:finished|succeeded)\.?$/i,
  /^(?:sent|delivered|created|updated|deleted|saved|installed)\.?$/i,
  /^(?:email|message) sent\.?$/i,
  // Greetings and conversational replies are valid short responses
  /^(?:hey|hi|hello|yo|sup|what'?s up|howdy|hola)/i,
];

const FALSE_POSITIVE_PATTERNS = [
  /(?:can'?t|cannot|couldn'?t) find (?:any|the|unread|new|recent)/i,
  /no (?:new |unread )?(?:emails|messages|tasks|assignments|notifications)/i,
  /inbox is (?:empty|clean|clear)/i,
  /nothing (?:new|due|pending|found)/i,
];

function detectFailure(response) {
  if (!response) return true;
  const trimmed = response.trim();
  if (!trimmed) return true;
  // Check for false positives first (these look like failures but aren't)
  if (FALSE_POSITIVE_PATTERNS.some(p => p.test(response))) return false;
  // Long responses are likely successful
  if (trimmed.length > 500) return false;
  // Short responses that match known success patterns are NOT failures
  if (SUCCESS_PATTERNS.some(p => p.test(trimmed))) return false;
  // Truly empty/meaningless responses are failures
  if (trimmed.length < 3) return true;
  // Only flag as failure if it actually matches a failure pattern
  // Short responses without failure patterns are fine (greetings, confirmations, etc.)
  return FAILURE_PATTERNS.some(p => p.test(response));
}

export async function runPipeline(prompt, { onProgress, processKey, timeout, resumeSessionId, sessionContext }) {
  const outputDir = config.outputDirectory;
  mkdirSync(outputDir, { recursive: true });
  const agg = createAggregator(onProgress);

  // ── Fast path: resumed session → skip A/B/C, send raw message ──
  // When resuming a conversation, the Claude session already has full context
  // from the previous turn(s). Re-running the pipeline would wrap the user's
  // follow-up in a fresh "Model D Executor" system prompt, destroying continuity.
  if (resumeSessionId) {
    await ensureBrowserReady();

    agg.phase('D', 'Continuing conversation (resumed session)');

    const phaseD = await runModel({
      userPrompt: prompt,
      systemPrompt: undefined,
      model: null,
      codexArgs: config.codexArgs,
      onProgress: (type, data) => agg.forward('D', type, data),
      processKey: processKey ? `${processKey}:D` : null,
      timeout,
      cwd: outputDir,
      resumeSessionId,
    });

    // If the resumed session returned empty (stale/invalid session ID),
    // fall through to the full pipeline instead of returning nothing.
    if (!phaseD.response || !phaseD.response.trim()) {
      agg.phase('D', 'Resumed session returned empty — starting fresh pipeline');
      resumeSessionId = null;
      // Fall through to full pipeline below
    } else {
      // Track Claude's session ID back to our internal session
      if (sessionContext && phaseD.sessionId) {
        setClaudeSessionId(sessionContext.id, phaseD.sessionId);
      }

      if (phaseD.questionRequest) {
        return {
          status: 'needs_user_input',
          questions: phaseD.questionRequest,
          sessionId: phaseD.sessionId,
          fullEvents: phaseD.fullEvents,
        };
      }

      // Fire-and-forget learning
      learnInBackground(prompt, { taskDescription: prompt }, phaseD.response, phaseD.fullEvents, onProgress, processKey, timeout);

      return {
        status: 'completed',
        response: redactSecrets(phaseD.response),
        sessionId: phaseD.sessionId,
        fullEvents: phaseD.fullEvents,
      };
    }
  }

  // ── Phase A: Output type classifier (local ML) ──
  agg.phase('A', 'Classifying request (local ML)');
  const phaseAResponse = await runPhaseA(prompt);
  const outputSpec = parseOutputSpec(phaseAResponse);
  const activeLabels = outputSpec.outputLabels
    ? Object.entries(outputSpec.outputLabels).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'
    : outputSpec.outputType || 'text';
  const scoreStr = outputSpec.outputScores
    ? ' | scores: ' + Object.entries(outputSpec.outputScores).map(([k, v]) => `${k}=${v}`).join(' ')
    : '';
  const intent = outputSpec.intent || 'query';
  agg.phase('A', `Complete → intent=${intent} formats=[${activeLabels}]${scoreStr}`);

  // ── Feedback loop: A → B → C? → D, max 3 iterations ──
  let loopCount = 0;
  let lastDResponse = null;
  let lastDSessionId = null;
  let lastDFullEvents = null;
  let previousFailure = null;
  const seenToolRequests = new Set(); // Track NEEDS_MORE_TOOLS to prevent duplicate requests

  while (loopCount < MAX_FEEDBACK_LOOPS) {
    loopCount++;

    // ── Phase B: Memory retrieval (local ML) + gap detection (Haiku on failure) ──
    const taskDesc = outputSpec.taskDescription || prompt;
    agg.phase('B', `Selecting relevant memory files (ML, pass ${loopCount})`);

    const inventory = getFullInventory();
    const phaseBResponse = await runPhaseB(
      previousFailure ? `${prompt}\n\nPrevious failure context: ${previousFailure.slice(0, 500)}` : prompt,
      inventory,
      intent,
      outputSpec.outputLabels || {}
    );
    const audit = parseAuditResult(phaseBResponse);
    const selectedSummary = (audit.selectedMemories || [])
      .map(m => `${m.name} (${m.reason || m.category})`)
      .join(', ') || 'none';
    onProgress?.('pipeline_phase', { phase: 'B', description: `Selected: ${selectedSummary}` });

    // Gap detection: only invoke Haiku when a previous execution failed
    if (previousFailure != null) {
      agg.phase('B', 'Detecting knowledge gaps (Haiku)');
      const gapModel = await runModel({
        userPrompt: `Output ONLY a raw JSON object. No prose. No explanation. Identify missing memories for the failed task.\n\nFailed task: ${taskDesc}\n\nFailure output: ${previousFailure.slice(0, 800)}`,
        systemPrompt: modelBGapPrompt(taskDesc, inventory, prompt, previousFailure),
        model: 'haiku',
        codexArgs: ['exec'],
        onProgress: (type, data) => agg.forward('B', type, data),
        processKey: processKey ? `${processKey}:Bgap` : null,
        timeout,
      });
      const gapAudit = parseAuditResult(gapModel.response);
      audit.missingMemories = gapAudit.missingMemories || [];
      audit.toolsNeeded = gapAudit.toolsNeeded || [];
      if (gapAudit.notes) audit.notes = (audit.notes ? audit.notes + ' | ' : '') + gapAudit.notes;
    }

    // If B didn't return valid JSON and we have a previous failure, force-create
    // a missing memory so C (Teacher) actually runs and researches the topic
    if (previousFailure != null && (!audit.missingMemories || audit.missingMemories.length === 0)) {
      onProgress?.('warning', { message: `Model B didn't identify gaps — forcing knowledge acquisition for: ${outputSpec.taskDescription}` });
      audit.missingMemories = [{
        name: outputSpec.taskDescription.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 50),
        category: 'knowledge',
        description: `How to: ${outputSpec.taskDescription}. The executor previously failed with: ${(previousFailure || '').slice(0, 300)}`,
        reason: 'Executor failed and auditor did not identify gaps — forcing research',
      }];
    }

    // ── Phase C: Teacher (if gaps found) ──
    let newlyCreatedMemories = [];
    if (audit.missingMemories && audit.missingMemories.length > 0) {
      agg.phase('C', `Creating ${audit.missingMemories.length} new memory file(s)`);

      const phaseC = await runModel({
        userPrompt: `Create the following memories:\n${audit.missingMemories.map(m => `- ${m.name}: ${m.description}`).join('\n')}`,
        systemPrompt: modelCPrompt(audit.missingMemories, inventory),
        model: null,
        codexArgs: ['exec'],
        onProgress: (type, data) => agg.forward('C', type, data),
        processKey: processKey ? `${processKey}:C` : null,
        timeout,
      });

      let teacherResult;
      try {
        teacherResult = parseTeacherResult(phaseC.response);
      } catch (err) {
        onProgress?.('warning', { message: `Phase C returned invalid result: ${err.message}` });
        teacherResult = { memories: [] };
      }
      for (const mem of teacherResult.memories) {
        try {
          await writeMemory(mem.name, mem.category, mem.content);
          newlyCreatedMemories.push(mem); // Keep for immediate use by D
          await tryInstallFromMemory(mem, onProgress);
        } catch (err) {
          // Non-fatal — log and continue
          onProgress?.('warning', { message: `Failed to write memory ${mem.name}: ${err.message}` });
        }
      }
    }

    // ── Phase D: Executor ──
    agg.phase('D', 'Executing task');


    // Gather memory contents for selected memories + newly created ones from C
    const selectedContents = getContents(audit.selectedMemories || []);
    // Add C's memories directly (they have name, category, content already)
    const newContents = newlyCreatedMemories.map(m => ({ name: m.name, category: m.category, content: m.content }));

    // Add site context detected from the prompt
    const selectedNames = new Set((audit.selectedMemories || []).map(m => m.name));
    const siteContext = detectSiteContext(prompt).filter(s => !selectedNames.has(s.name));
    const allMemoryContents = [...selectedContents, ...newContents, ...siteContext];

    // Always ensure browser is ready before Phase D — fast no-op if already running
    await ensureBrowserReady();

    const phaseD = await runModel({
      userPrompt: prompt,
      systemPrompt: modelDPrompt(prompt, outputSpec, allMemoryContents),
      model: null,
      codexArgs: config.codexArgs,
      onProgress: (type, data) => agg.forward('D', type, data),
      processKey: processKey ? `${processKey}:D` : null,
      timeout,
      cwd: outputDir,
      resumeSessionId,
    });

    // Track Claude's session ID back to our internal session
    if (sessionContext && phaseD.sessionId) {
      setClaudeSessionId(sessionContext.id, phaseD.sessionId);
    }

    if (phaseD.questionRequest) {
      return {
        status: 'needs_user_input',
        questions: phaseD.questionRequest,
        sessionId: phaseD.sessionId,
        fullEvents: phaseD.fullEvents,
      };
    }

    lastDResponse = phaseD.response;
    lastDSessionId = phaseD.sessionId;
    lastDFullEvents = phaseD.fullEvents;

    // Check if Model D needs more tools/knowledge or failed entirely
    const needsMore = lastDResponse?.match(/\[NEEDS_MORE_TOOLS:\s*(.+?)\]/);
    if (needsMore && loopCount < MAX_FEEDBACK_LOOPS) {
      const toolsNeeded = needsMore[1].trim();
      // Prevent the same tool request from looping — if we already tried this, give up
      if (seenToolRequests.has(toolsNeeded.toLowerCase())) {
        agg.phase('feedback', `Already attempted to resolve: ${toolsNeeded}. Stopping retry loop.`);
        break;
      }
      seenToolRequests.add(toolsNeeded.toLowerCase());
      agg.phase('feedback', `Model D needs: ${toolsNeeded}. Bypassing B and injecting targeted memory request.`);
      // Bypass B entirely — inject a precise missingMemories entry so C researches exactly what's needed
      audit.missingMemories = [buildToolMemoryRequest(toolsNeeded)];
      previousFailure = lastDResponse;
      // Skip directly to C by re-entering the loop at the right point
      if (loopCount < MAX_FEEDBACK_LOOPS) {
        agg.phase('C', `Creating 1 new memory file(s) for: ${toolsNeeded}`);
        const phaseC2 = await runModel({
          userPrompt: `Create the following memories:\n- ${audit.missingMemories[0].name}: ${audit.missingMemories[0].description}`,
          systemPrompt: modelCPrompt(audit.missingMemories, getFullInventory()),
          model: null,
          codexArgs: ['exec'],
            onProgress: (type, data) => agg.forward('C', type, data),
          processKey: processKey ? `${processKey}:C2` : null,
          timeout,
        });
        let teacherResult2;
        try {
          teacherResult2 = parseTeacherResult(phaseC2.response);
        } catch (err) {
          onProgress?.('warning', { message: `Phase C2 returned invalid result: ${err.message}` });
          teacherResult2 = { memories: [] };
        }
        for (const mem of teacherResult2.memories) {
          try {
            await writeMemory(mem.name, mem.category, mem.content);
            newlyCreatedMemories.push(mem);
            // If this memory describes how to install a tool, run the install now
            await tryInstallFromMemory(mem, onProgress);
          } catch (err) {
            onProgress?.('warning', { message: `Failed to write memory ${mem.name}: ${err.message}` });
          }
        }
        // Re-run D with the new memory (deduplicate site context against selected memories)
        const d2SelectedNames = new Set((audit.selectedMemories || []).map(m => m.name));
        const d2SiteContext = detectSiteContext(prompt).filter(s => !d2SelectedNames.has(s.name));
        const updatedContents = [...getContents(audit.selectedMemories || []), ...newlyCreatedMemories.map(m => ({ name: m.name, category: m.category, content: m.content })), ...d2SiteContext];
        await ensureBrowserReady();
        const phaseD2 = await runModel({
          userPrompt: prompt,
          systemPrompt: modelDPrompt(prompt, outputSpec, updatedContents),
          model: null,
          codexArgs: config.codexArgs,
          onProgress: (type, data) => agg.forward('D', type, data),
          processKey: processKey ? `${processKey}:D2` : null,
          timeout,
          cwd: outputDir,
          resumeSessionId,
                });
        if (phaseD2.questionRequest) {
          return { status: 'needs_user_input', questions: phaseD2.questionRequest, sessionId: phaseD2.sessionId, fullEvents: phaseD2.fullEvents };
        }
        lastDResponse = phaseD2.response;
        lastDSessionId = phaseD2.sessionId;
        lastDFullEvents = phaseD2.fullEvents;
      }
      break;
    }

    if (detectFailure(lastDResponse) && loopCount < MAX_FEEDBACK_LOOPS) {
      agg.phase('feedback', `Model D couldn't complete the task. Looping back to B for more knowledge.`);
      previousFailure = lastDResponse || '(executor returned empty response)';
      continue;
    }

    break;
  }

  // ── Post-task learning (fire-and-forget) ──
  learnInBackground(prompt, outputSpec, lastDResponse, lastDFullEvents, onProgress, processKey, timeout);

  // Auto-attach visual outputs that Model D created but forgot to mark with [IMAGE:]
  const finalResponse = attachUnmarkedImages(lastDResponse || '', outputDir);

  return {
    status: 'completed',
    response: redactSecrets(finalResponse),
    sessionId: lastDSessionId,
    fullEvents: lastDFullEvents,
  };
}

// Scan outputs directory for recently created image files not already marked in the response.
// Appends [IMAGE: path] markers so the transport layer (WhatsApp, web) sends them to the user.
function attachUnmarkedImages(response, outputDir) {
  const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf']);
  const cutoff = Date.now() - 300000; // files created in last 5 minutes

  const alreadyMarked = new Set();
  const markerPattern = /\[IMAGE:\s*([^\]]+)\]/g;
  let m;
  while ((m = markerPattern.exec(response)) !== null) {
    alreadyMarked.add(m[1].trim());
  }

  const newImages = [];
  function walk(dir) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
        if (!IMAGE_EXTS.has(ext)) continue;
        try {
          const stat = statSync(full);
          if (stat.mtimeMs > cutoff && !alreadyMarked.has(full)) {
            newImages.push(full);
          }
        } catch {}
      }
    } catch {}
  }
  walk(outputDir);

  if (newImages.length === 0) return response;
  const markers = newImages.map(p => `[IMAGE: ${p}]`).join('\n');
  return response + '\n\n' + markers;
}

// Maps a [NEEDS_MORE_TOOLS] description to a targeted missingMemories entry for Model C.
function buildToolMemoryRequest(toolsNeeded) {
  const lower = toolsNeeded.toLowerCase();
  if (lower.includes('playwright')) {
    return {
      name: 'playwright-mcp-setup',
      category: 'knowledge',
      description: 'How to install and use the Playwright MCP server (claude mcp add playwright) on Windows so that Claude Code subprocesses have access to browser_navigate, browser_snapshot, browser_click and other browser automation tools. Include: exact install command, how to verify it is active, and how to use it in a claude --print subprocess.',
      reason: toolsNeeded,
    };
  }
  // Generic fallback — let C figure it out from the description
  const slug = toolsNeeded.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 50);
  return {
    name: `tool-setup-${slug}`,
    category: 'knowledge',
    description: `How to install and use: ${toolsNeeded}. Include exact install/setup commands for Windows and how to verify the tool is available.`,
    reason: toolsNeeded,
  };
}

// Safe command patterns — only these prefixes are allowed for auto-install.
// Anything else from an LLM-written memory file could be arbitrary code execution.
const SAFE_INSTALL_PATTERNS = [
  /^npm\s+install\b/,
  /^npx\s+/,
  /^pip\s+install\b/,
  /^pip3\s+install\b/,
  /^claude\s+mcp\s+add\b/,
  /^winget\s+install\b/,
  /^choco\s+install\b/,
  /^uv\s+pip\s+install\b/,
];

// If a freshly-created memory describes tool installs, run them immediately so D can use them.
// Only allows commands matching SAFE_INSTALL_PATTERNS to prevent command injection.
async function tryInstallFromMemory(mem, onProgress) {
  const content = mem.content || '';

  // Collect ALL install_command: lines in the file (there may be multiple steps)
  const lines = content.split('\n');
  const installLines = lines
    .map(l => l.match(/^\s*install_command:\s*(.+)/i))
    .filter(Boolean)
    .map(m => {
      let cmd = m[1].trim();
      // Strip trailing markdown artifacts (**, __, *, etc.)
      cmd = cmd.replace(/[*_`]+$/, '').trim();
      // Replace bare 'claude' with full path from config (node's PATH may not include it)
      cmd = cmd.replace(/^claude\b/, config.claudeCommand);
      return cmd;
    })
    .filter(cmd => cmd.length > 0);

  for (const cmd of installLines) {
    // Security: only allow known-safe install commands
    if (!SAFE_INSTALL_PATTERNS.some(p => p.test(cmd))) {
      console.warn(`[security] Blocked unsafe install command from memory: ${cmd}`);
      onProgress?.('warning', { message: `Blocked unsafe install command: ${cmd}` });
      continue;
    }
    // Reject commands containing shell metacharacters to prevent injection
    if (/[;&|`$(){}]/.test(cmd)) {
      console.warn(`[security] Blocked shell metacharacters in install command: ${cmd}`);
      onProgress?.('warning', { message: `Blocked suspicious install command: ${cmd}` });
      continue;
    }
    onProgress?.('tool_install', { message: `Installing: ${cmd}` });
    try {
      // Split into executable + args to avoid shell interpretation
      const parts = cmd.split(/\s+/);
      execFileSync(parts[0], parts.slice(1), { stdio: 'pipe', timeout: 60000 });
      onProgress?.('tool_install', { message: `Installed: ${cmd}` });
    } catch (err) {
      onProgress?.('warning', { message: `Install failed (${cmd}): ${err.message?.slice(0, 200)}` });
    }
  }
}

function learnInBackground(prompt, outputSpec, executionResponse, fullEvents, onProgress, processKey, timeout) {
  const agg = createAggregator(onProgress);

  // Don't await — fire and forget
  (async () => {
    try {
      agg.phase('learn', 'Reviewing execution for learnings');

      const inventory = getFullInventory();

      // Build a compact execution trace from fullEvents: tool calls + results + assistant text
      let executionTrace = '';
      let inefficiencyReport = '';
      if (Array.isArray(fullEvents)) {
        const traceLines = [];
        const toolCallCounts = {};
        const methodAttempts = [];
        let lastToolName = null;

        for (const ev of fullEvents) {
          // Handle raw stream-json format from Claude CLI
          if (ev.type === 'assistant') {
            if (ev.subtype === 'tool_use') {
              // Legacy format: tool_use at top level
              const key = ev.tool_name || 'unknown';
              toolCallCounts[key] = (toolCallCounts[key] || 0) + 1;
              const inputStr = JSON.stringify(ev.input || {}).slice(0, 200);
              traceLines.push(`TOOL_USE[${toolCallCounts[key]}]: ${key} ${inputStr}`);
              lastToolName = key;
            } else if (ev.message?.content) {
              // Current format: tool_use inside message.content blocks
              for (const block of ev.message.content) {
                if (block.type === 'tool_use') {
                  const key = block.name || 'unknown';
                  toolCallCounts[key] = (toolCallCounts[key] || 0) + 1;
                  const inputStr = JSON.stringify(block.input || {}).slice(0, 200);
                  traceLines.push(`TOOL_USE[${toolCallCounts[key]}]: ${key} ${inputStr}`);
                  lastToolName = key;
                } else if (block.type === 'text' && block.text) {
                  traceLines.push(`ASSISTANT: ${block.text.slice(0, 300)}`);
                }
              }
            }
          } else if (ev.type === 'user') {
            if (ev.subtype === 'tool_result') {
              const out = typeof ev.output === 'string' ? ev.output : JSON.stringify(ev.output || '');
              const isError = (ev.is_error) || out.toLowerCase().includes('error') || out.toLowerCase().includes('failed');
              traceLines.push(`TOOL_RESULT${isError ? '[ERROR]' : '[OK]'}: ${out.slice(0, 300)}`);
              if (lastToolName) {
                methodAttempts.push({ tool: lastToolName, succeeded: !isError });
              }
            } else if (ev.message?.content) {
              for (const block of ev.message.content) {
                if (block.type === 'tool_result') {
                  const out = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
                  const isError = block.is_error || out.toLowerCase().includes('error');
                  traceLines.push(`TOOL_RESULT${isError ? '[ERROR]' : '[OK]'}: ${out.slice(0, 300)}`);
                  if (lastToolName) {
                    methodAttempts.push({ tool: lastToolName, succeeded: !isError });
                  }
                }
              }
            }
          } else if (ev.type === 'assistant_text' && ev.text) {
            traceLines.push(`ASSISTANT: ${ev.text.slice(0, 300)}`);
          } else if (ev.type === 'stderr' && ev.text) {
            traceLines.push(`STDERR: ${ev.text.slice(0, 200)}`);
          }
        }

        // Build inefficiency report
        const inefficiencies = [];
        const totalCalls = Object.values(toolCallCounts).reduce((a, b) => a + b, 0);

        for (const [tool, count] of Object.entries(toolCallCounts)) {
          if (count >= 4) {
            const failures = methodAttempts.filter(m => m.tool === tool && !m.succeeded).length;
            const successes = count - failures;
            inefficiencies.push(`REPEATED_TOOL: "${tool}" called ${count}x (${failures} failures, ${successes} successes)`);
          }
        }

        let failStreak = 0;
        let failTools = [];
        for (const attempt of methodAttempts) {
          if (!attempt.succeeded) {
            failStreak++;
            if (!failTools.includes(attempt.tool)) failTools.push(attempt.tool);
          } else {
            if (failStreak >= 3) {
              inefficiencies.push(`SLOW_PATH: ${failStreak} failures (tools: ${failTools.join(', ')}) before "${attempt.tool}" succeeded`);
            }
            failStreak = 0;
            failTools = [];
          }
        }

        if (totalCalls > 15) {
          inefficiencies.push(`HIGH_VOLUME: ${totalCalls} total tool calls — task took many steps`);
        }

        if (inefficiencies.length > 0) {
          inefficiencyReport = `\n\n## Inefficiency Report (auto-detected)\n${inefficiencies.join('\n')}\nTotal tool calls: ${totalCalls}`;
        }

        executionTrace = traceLines.join('\n');
      }
      if (executionTrace.length > 8000) executionTrace = '...(truncated)\n' + executionTrace.slice(-8000);

      // Always give the learner the session-log-analyzer skill for structured analysis
      let analyzerSkill = '';
      const analyzerPath = join(MEMORY_ROOT, 'skills', 'session-log-analyzer', 'SKILL.md');
      if (existsSync(analyzerPath)) {
        try { analyzerSkill = `\n\n## Session Log Analysis Methodology\n${readFileSync(analyzerPath, 'utf-8')}`; } catch {}
      }

      const result = await runModel({
        userPrompt: `Review this execution and save any useful knowledge.\n\nPrompt: ${prompt}\n\nFinal response: ${(executionResponse || '').slice(0, 1000)}${inefficiencyReport}\n\nExecution trace:\n${executionTrace}`,
        systemPrompt: learnerPrompt(prompt, outputSpec, (executionResponse || '').slice(0, 2000), inventory) + analyzerSkill,
        model: 'sonnet',
        onProgress: (type, data) => agg.forward('learner', type, data),
        processKey: processKey ? `${processKey}:learner` : null,
        timeout: timeout || 900000,
      });

      const learnerResult = parseLearnerResult(result.response);
      if (!learnerResult.updates || learnerResult.updates.length === 0) {
        process.stderr.write(`[learner] No updates extracted from learner response (length=${(result.response || '').length})\n`);
      }
      for (const update of learnerResult.updates) {
        try {
          if (update.path) {
            if (update.path.includes('..') || update.path.startsWith('/') || /^[a-zA-Z]:/.test(update.path) || update.path.includes('\\')) {
              process.stderr.write(`[learner] Blocked path traversal: ${update.path}\n`);
              continue;
            }
            await updateMemory(update.path, 'append', update.content);
            process.stderr.write(`[learner] Appended to ${update.path}\n`);
          } else {
            const currentInventory = getFullInventory();
            const existingMatch = currentInventory.find(m => m.name === update.name);
            if (existingMatch?.path) {
              await updateMemory(existingMatch.path, 'append', update.content);
              process.stderr.write(`[learner] Appended to existing memory: ${update.name} (${existingMatch.path})\n`);
            } else {
              await writeMemory(update.name, update.category, update.content);
              process.stderr.write(`[learner] Created new memory: ${update.name} (${update.category})\n`);
            }
          }
        } catch (err) {
          process.stderr.write(`[learner] Failed to write memory ${update.name || update.path}: ${err.message}\n`);
        }
      }

      // Rebuild the memory index after all writes
      try {
        const updatedInventory = getFullInventory();
        const byCategory = {};
        for (const m of updatedInventory) {
          if (!byCategory[m.category]) byCategory[m.category] = [];
          byCategory[m.category].push(m);
        }
        const lines = [`# Memory Index\n_Auto-updated after each learning pass. ${updatedInventory.length} total entries._\n`];
        for (const [cat, items] of Object.entries(byCategory)) {
          lines.push(`\n## ${cat.charAt(0).toUpperCase() + cat.slice(1)}s (${items.length})`);
          for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
            lines.push(`- **${item.name}**: ${item.description}`);
          }
        }
        await updateMemory(join(MEMORY_ROOT, 'memory-index.md'), 'replace', lines.join('\n'));
        process.stderr.write(`[learner] Memory index updated (${updatedInventory.length} entries)\n`);
      } catch (indexErr) {
        process.stderr.write(`[learner] Failed to update memory index: ${indexErr.message}\n`);
      }
    } catch (err) {
      process.stderr.write(`[learner] Learning failed: ${err.message}\n`);
    }
  })();
}
