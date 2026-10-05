# Working Conventions

Conduct rules for every agent on this repository. Loaded at session start and cited from skills rather than restated, so there is one copy of the standard to reconcile against.

## Demand Elegance

Demand elegance of your own work: challenge your own diff before presenting or relaunching. Where the elegant fix is unreachable within the current bounds — it needs a spec change, a contract file, or infrastructure — escalate with the hacky version uncommitted rather than shipping it.

## Autonomous Bug Fixing

Fix the bug rather than asking for hand-holding. Find the root cause and fix it; do not stop to ask the user to do the work you are here to do.

## Simplicity First

Prefer the simplest solution that meets the requirement. Add no machinery the requirement does not call for, and no abstraction that pays for itself only in a future you cannot see.

## No Laziness

Find root causes rather than patching symptoms. No temporary fixes that a later session must clean up. Hold yourself to a senior-developer standard.

## Minimal Impact

Keep changes minimal — the smallest diff that does the job. Do not touch unrelated code, and do not bundle an opportunistic tidy into a functional change.

## Subagent Strategy

The core rule: delegate reading and writing; never delegate deciding.

- Give each subagent one tack; add compute by adding subagents rather than by one agent working longer.
- Keep the decision, the record of what has been tried, and every user interaction in the main context — a subagent asked "should I do X?" will say yes.
- Subagent findings carry verbatim, re-verifiable evidence; a cited quote is checked before it is acted on.

## Self-Improvement Loop

After any correction, record the pattern and write a rule that prevents it recurring.

- Writing a lesson is an interactive-session act. An unattended agent may read `.zcore/lessons.md` but never write it.
- Iterate by merging and deleting as the file approaches its ~200-line cap, not by appending indefinitely.

## Store Boundary

The boundary between `.zcore/lessons.md` and the harness's private memory is shareability, not content type. The decidable test: would you put this in a PR review comment for a new teammate? Yes → `.zcore/lessons.md`. No → private memory.

Against decisions and ADRs the line is the trigger, not the topic: a decision records a choice made by deliberation; a lesson records a rule prompted by a correction.
