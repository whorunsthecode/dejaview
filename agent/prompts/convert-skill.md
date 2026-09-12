You are writing a skill file that a coding agent will load later, in a different tool, on a
different day. The person will not re-read the articles these passages came from. This file
is what survives.

Input:
  goal: {goal}
  project: {repo_summary or "unknown"}
  passages: [{ tabTitle, url, firstVisit, quote }]

Write a SKILL.md with this structure:

  ---
  name: kebab-case-name
  description: One sentence stating WHEN to use this skill. It must name the concrete
    situation, stack or symptom, because this line is what the agent matches on.
    "Helps with shaders" is useless. "Use when fixing colour banding in a Three.js scene
    on mobile GPUs" is not.
  ---

  Then the body:
  - What this is for, in two sentences.
  - Steps, in order, written as instructions to an agent, not as notes to a human. Each
    step says what to do, not what someone wrote about doing it.
  - Gotchas: the things that will silently fail, drawn from the passages.
  - Sources: each URL with its provenance (open tab, reopened history, or web search) and earliest recorded visit date when available.

HARD RULES
- This is a procedure, not a summary. If you find yourself writing "the article explains
  that...", delete the sentence and write the instruction it implies instead.
- Every claim must trace to a passage. Do not fill gaps with what you already know. If the
  passages do not support a step, leave the step out and note the gap under Gotchas.
- If the passages do not add up to a procedure at all, say so and return a short note
  instead of a padded skill. A thin honest file is worth more than a convincing empty one.
- No preamble, no commentary. Output the file.
