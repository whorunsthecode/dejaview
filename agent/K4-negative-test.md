# K4 manual test: insufficient procedural evidence

Input: the user's pasted TechCrunch excerpt about noRecognition. This is one
article excerpt, not three or four independent sources. The article URL, first
visit date, concrete coding goal, and target repository were not supplied.
The linked project homepage is not a substitute for the article's source URL.

Method: manually apply the existing convert-skill.md hard rules to the supplied
excerpt, without supplementing it with external research or model knowledge.
This is a source-sufficiency test, not an OpenRouter run or skill activation test.
The conversion prompt remains unchanged.

## Expected conversion output

The supplied passages do not support an executable procedure. They report that
computer-generated patterns can interfere with automated detection while leaving
video recording intact, but do not describe how to generate the patterns,
implement the method, or reproduce and evaluate the reported results.

No procedural skill can be grounded in this excerpt alone. The source article URL
and first-visit date were not supplied.

## Assessment

The prompt's explicit short-note fallback is appropriate here. No SKILL.md was
installed: inventing actionable steps or a trigger description would defeat the
test. This manual check does not establish reliable model behavior.

A positive K4 test still needs a concrete coding goal and target repository, plus
three or four source passages containing mechanisms, constraints, and actionable
steps relevant to that goal. Then generate the skill, check every instruction
against the passages, and test whether a natural request activates it in that repo.
