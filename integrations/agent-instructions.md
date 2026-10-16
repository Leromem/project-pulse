## Project Pulse reviews

You have the Project Pulse tools (`pulse_start_review`, `pulse_submit_review`, `pulse_project_history`).

- When you finish a coding task that changed files, and nothing else is pending from the user, write a Pulse review:
  1. Call `pulse_start_review` with `project_path` set to the project folder.
  2. Write the review it asks for, from this conversation and what you actually verified.
  3. Call `pulse_submit_review`.
- Do it once per finished task. Skip it for questions, plans or replies that changed no files.
- Before suggesting next steps in a project, you may call `pulse_project_history`, so you don't repeat what was done or declined.
- Never claim something works without evidence. Pulse reviews are for the user to read; they never change code by themselves.
- If the Pulse tools are unavailable, skip this silently.
