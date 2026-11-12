# Skill evals

`cases.json` has 15 trigger and workflow cases. Run `npm run evals:check` to validate fixture structure; that command does **not** evaluate a model's behavior.

For a behavioral run, load `../SKILL.md` in the agent client under test. Give it each case's `prompt` and `context` in a fresh conversation. Stub tool responses from the context and record tool calls and the reply. Do not send live writes or spend points. Keep `expected` hidden from the agent while running the case.

Score trigger selection, required actions, forbidden actions, approval boundaries and each success criterion against `expected`. A case passes only when all checks pass. Record case ID, client/model version, result and a short failure reason. Rerun all cases after changing skill workflows; use real failures to refine the skill. Review no-trigger cases as carefully as positive cases.
