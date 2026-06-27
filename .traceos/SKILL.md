# TraceOS Memory

## What This Skill Does

TraceOS gives you persistent memory across coding sessions. It captures your project's diagnostics, git changes, terminal errors, and previous agent failures, then recalls only the relevant memories for each new request.

Before starting any task, read .traceos/TRACEOS_CONTEXT.md - it contains exact evidence from the current workspace including repeated failures to avoid, relevant git changes, and previous agent error patterns.

## Rules When Using TraceOS Memory

- ALWAYS read .traceos/TRACEOS_CONTEXT.md before writing any code
- Use ONLY evidence shown in the context - do not invent errors not listed
- If a fix was already attempted and failed (shown in Previous TraceOS Memories), do NOT attempt it again
- Prefer editing files listed in Current Git Status or Current Exact Diagnostics
- If evidence is missing or unclear, say so rather than assuming

## How Context Is Structured

The context file contains these sections:
- Current Exact Diagnostics: live VS Code errors right now
- Current Git Status / Diff: what files changed
- Recent Terminal Log: captured terminal output with errors
- Repeated Diagnostics: errors seen across multiple sessions
- Previous TraceOS Memories: recalled relevant past failures and fixes

## Integration

TraceOS writes context automatically before each agent run. No manual setup needed. The context file is always at .traceos/TRACEOS_CONTEXT.md relative to the workspace root.
